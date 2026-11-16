// node:os for main-process code in a page: the machine facts from the shell's start-up info, and the network
// interfaces fresh each time (the LAN room recomputes its broadcast addresses when they change).
import { boot } from '../bootInfo';
import { sysSync } from '../sys';

const win = (): boolean => boot().platform === 'win32';

export const EOL = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent) ? '\r\n' : '\n';
export const platform = (): string => boot().platform;
export const arch = (): string => (boot().arch === 'x86_64' ? 'x64' : boot().arch === 'aarch64' ? 'arm64' : boot().arch);
export const type = (): string => (win() ? 'Windows_NT' : boot().platform === 'darwin' ? 'Darwin' : 'Linux');
export const release = (): string => '';
export const homedir = (): string => boot().home;
export const tmpdir = (): string => boot().temp;
export const hostname = (): string => boot().env.COMPUTERNAME ?? boot().env.HOSTNAME ?? 'localhost';
export const cpus = (): unknown[] => [];
export const totalmem = (): number => 0;

export function userInfo(): { username: string; homedir: string; shell: string | null; uid: number; gid: number } {
  const username = boot().env.USERNAME ?? boot().env.USER ?? boot().env.LOGNAME;
  if (!username) throw new Error('no user name');
  return { username, homedir: boot().home, shell: null, uid: -1, gid: -1 };
}

interface RawInterface {
  name: string;
  family: 'IPv4' | 'IPv6';
  address: string;
  netmask: string;
  internal: boolean;
}

export interface NetworkInterfaceInfo {
  address: string;
  netmask: string;
  family: 'IPv4' | 'IPv6';
  mac: string;
  internal: boolean;
  cidr: string | null;
}

export function networkInterfaces(): Record<string, NetworkInterfaceInfo[]> {
  const out: Record<string, NetworkInterfaceInfo[]> = {};
  let list: RawInterface[] = [];
  try {
    list = sysSync<RawInterface[]>('interfaces');
  } catch {
    // no interfaces is what Node reports offline too
  }
  for (const i of list) {
    (out[i.name] ??= []).push({ address: i.address, netmask: i.netmask, family: i.family, mac: '00:00:00:00:00:00', internal: i.internal, cidr: null });
  }
  return out;
}

export default { EOL, platform, arch, type, release, homedir, tmpdir, hostname, cpus, totalmem, userInfo, networkInterfaces };
