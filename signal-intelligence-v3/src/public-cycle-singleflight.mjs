/** Linux kernel advisory single-flight for public V3 producer.
 * The systemd timer and loopback manual-rescan route MUST share a lock.
 * flock automatically releases the kernel lock on process exit, including
 * crashes; a stranded PID file is never treated as active authority.
 * No exchange, Telegram, DB, order or filesystem ACL changes.
 */
import {dirname,join,isAbsolute} from 'node:path';
export const V3_PUBLIC_CYCLE_CONFLICT_EXIT=75;
export const V3_PUBLIC_FLOCK='/usr/bin/flock';
export const V3_PUBLIC_CYCLE_LOCK_NAME='public-cycle.lock';
export function v3PublicCycleLockCommand(stateFile,producerPath,{
  nodeBinary=process.execPath,
}={}){
  if(typeof stateFile!=='string'||!isAbsolute(stateFile)
    ||typeof producerPath!=='string'||!isAbsolute(producerPath)
    ||!producerPath.endsWith('.mjs')
    ||typeof nodeBinary!=='string'||!isAbsolute(nodeBinary))
    throw new Error('V3_PUBLIC_CYCLE_LOCK_CONFIG_INVALID');
  const lockPath=join(dirname(stateFile),V3_PUBLIC_CYCLE_LOCK_NAME);
  return Object.freeze({
    command:V3_PUBLIC_FLOCK,
    args:Object.freeze(['-n','-E',String(V3_PUBLIC_CYCLE_CONFLICT_EXIT),
      lockPath,nodeBinary,producerPath]),
    lockPath,conflictExitCode:V3_PUBLIC_CYCLE_CONFLICT_EXIT,
    executionAuthority:'NONE',
  });
}
