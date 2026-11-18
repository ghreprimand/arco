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

// The private addresses the running listener serves. This depends only on
// the listener and the machine's interfaces, never on the URL or route the
// desktop page used: a page opened by machine name, by another address or
// through a proxy is offered the same direct addresses a phone can reach.
// A wildcard listener serves every private interface (container bridges
// excluded); a listener bound to one address serves only that address.
function privateListeners(req: IncomingMessage): PhoneUploadNetwork[] {
  if (!req.socket.localPort || (req.socket as { encrypted?: boolean }).encrypted) return [];
  const local = address(req.socket.localAddress);
  const wildcard = HOST === '::' || HOST === '0.0.0.0';
  const networks = new Map<string, PhoneUploadNetwork>();
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (wildcard && /^(docker|veth|virbr|br-)/i.test(name)) continue;
    const tailnet = /tailscale/i.test(name) || !!entries?.some(entry => /^fd7a:115c:a1e0:/i.test(entry.address));
    for (const entry of entries ?? []) {
      const ip = address(entry.address);
      if (wildcard ? HOST === '0.0.0.0' && family(ip) !== 'ipv4' : ip !== local) continue;
      const network = privateInterface(entry, tailnet, req.socket.localPort);
      if (network) networks.set(network.origin, network);
    }
  }
  return [...networks.values()];
}

/**
 * The IPv4 private network and tailnet addresses of this machine that a
 * phone could reach, container bridges excluded. The temporary phone
 * listener binds each one separately, never a wildcard.
 */
export function phoneListenerAddresses(): string[] {
  const found = new Set<string>();
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|veth|virbr|br-)/i.test(name)) continue;
    const tailnet = /tailscale/i.test(name) || !!entries?.some(entry => /^fd7a:115c:a1e0:/i.test(entry.address));
    for (const entry of entries ?? []) {
      const network = family(address(entry.address)) === 'ipv4' ? privateInterface(entry, tailnet, 1) : null;
      if (network) found.add(network.address);
    }
  }
  return [...found];
}

export function phoneUploadOrigins(req: IncomingMessage): string[] {
  return privateListeners(req).map(network => network.origin);
}

export function privatePhoneOrigin(req: IncomingMessage): string | undefined {
  const local = address(req.socket.localAddress);
  const peer = address(req.socket.remoteAddress);
  if (!isDirect(req) || !isIP(peer) || loopback(peer)) return undefined;
  return privateListeners(req).find(network => network.address === local
    && canReach(network, peer) && req.headers.host === new URL(network.origin).host)?.origin;
}
