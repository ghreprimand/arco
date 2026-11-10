// Every runtime version is locked. HTTPS-source packages are bundled below
// so installation never depends on reaching their original download host.
export function runtimeDependencySpec(name, declared, lock) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`Missing locked runtime dependency: ${name}`);
  return version;
}

export function archiveRuntimeDependencies(declared) {
  return Object.entries(declared).filter(([,spec]) => typeof spec === 'string' && spec.startsWith('https://')).map(([name]) => name);
}
