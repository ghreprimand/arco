import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import os, { type NetworkInterfaceInfo } from 'node:os';
import { HOST } from '../server/constants.js';

type Family = 'ipv4' | 'ipv6';

interface PhoneUploadNetwork {
  address: string;
  origin: string;
  peers: BlockList;
  tailnet: boolean;
}

const privateNetworks = new BlockList();
// RFC 1918 IPv4 network prefixes, in octets.
for (const [first, second, prefix] of [[10, 0, 8], [172, 16, 12], [192, 168, 16]]) {
  privateNetworks.addSubnet([first, second, 0, 0].join('.'), prefix);
}
privateNetworks.addSubnet('fc00::', 7, 'ipv6');

const tailscaleNetworks = new BlockList();
tailscaleNetworks.addSubnet([100, 64, 0, 0].join('.'), 10);
tailscaleNetworks.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

function address(ip: string | undefined): string {
  return (ip ?? '').replace(/^::ffff:(?=\d)/i, '').split('%')[0].toLowerCase();
}

function family(ip: string): Family {
  return isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

function loopback(ip: string): boolean {
  return ip === '::1' || /^127\./.test(ip);
}

function isDirect(req: IncomingMessage): boolean {
  return !req.headers.forwarded && !req.headers['x-forwarded-for']
    && !req.headers['x-forwarded-proto'] && !req.headers['x-forwarded-host'];
}

function privateInterface(entry: NetworkInterfaceInfo, tailnet: boolean, port: number): PhoneUploadNetwork | null {
  if (entry.internal || !entry.cidr) return null;
  const ip = address(entry.address);
  const kind = family(ip);
  const isTailnet = tailnet && tailscaleNetworks.check(ip, kind);
  if (!isTailnet && !privateNetworks.check(ip, kind)) return null;
  const peers = isTailnet ? tailscaleNetworks : new BlockList();
  if (!isTailnet) {
    const prefix = Number(entry.cidr.split('/')[1]);
    if (prefix <= 0 || prefix > (kind === 'ipv4' ? 32 : 128)) return null;
    peers.addSubnet(ip, prefix, kind);
  }
  const host = kind === 'ipv6' ? `[${ip}]` : ip;
  return { address: ip, origin: new URL(`http://${host}:${port}`).origin, peers, tailnet: isTailnet };
}

function canReach(network: PhoneUploadNetwork, peer: string): boolean {
  const kind = family(peer);
  return isIP(peer) !== 0 && (network.tailnet ? tailscaleNetworks : privateNetworks).check(peer, kind)
    && network.peers.check(peer, kind);
}

function privateListeners(req: IncomingMessage): PhoneUploadNetwork[] {
  if (!isDirect(req) || !req.socket.localPort || (req.socket as { encrypted?: boolean }).encrypted) return [];
  const local = address(req.socket.localAddress);
  const peer = address(req.socket.remoteAddress);
  const wildcard = HOST === '::' || HOST === '0.0.0.0';
  const host = req.headers.host ?? '';
  const localDesktop = wildcard && loopback(local) && loopback(peer)
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const networks = new Map<string, PhoneUploadNetwork>();
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (localDesktop && /^(docker|veth|virbr|br-)/i.test(name)) continue;
    const tailnet = /tailscale/i.test(name) || !!entries?.some(entry => /^fd7a:115c:a1e0:/i.test(entry.address));
    for (const entry of entries ?? []) {
      const ip = address(entry.address);
      if (ip !== local && (!localDesktop || (HOST === '0.0.0.0' && family(ip) !== 'ipv4'))) continue;
      const network = privateInterface(entry, tailnet, req.socket.localPort);
      if (network && (localDesktop || canReach(network, peer))) {
        networks.set(network.origin, network);
      }
    }
  }
  return [...networks.values()];
}

export function phoneUploadOrigins(req: IncomingMessage): string[] {
  return privateListeners(req).map(network => network.origin);
}

export function privatePhoneOrigin(req: IncomingMessage): string | undefined {
  const local = address(req.socket.localAddress);
  const peer = address(req.socket.remoteAddress);
  if (!isIP(peer) || loopback(peer)) return undefined;
  return privateListeners(req).find(network => network.address === local
    && canReach(network, peer) && req.headers.host === new URL(network.origin).host)?.origin;
}
