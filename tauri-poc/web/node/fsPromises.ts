// node:fs/promises: the promise half of ./fs.
import { promises } from './fs';

export const {
  readFile, writeFile, appendFile, mkdir, readdir, rm, unlink, stat, lstat, rename, copyFile, access, chmod, open,
} = promises;
export default promises;
