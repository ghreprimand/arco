import type { HomeProject } from '../../utils/homeModel';

function pathKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function projectNameForDirectory(directory: string, projects: HomeProject[]): string {
  const key = pathKey(directory);
  if (!key) return '';
  const basename = directory.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  return projects.find(project => pathKey(project.path) === key)?.name || basename || '';
}
