/** Send `signal` to every process in the group led by `pid`; a group that is already gone is fine. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

/**
 * SIGKILL the group led by `pid` (a child spawned with `detached: true` that has already exited) and wait until none of
 * its processes remain, so nothing a wrapper started outlives it. False when some survive `timeoutMs`.
 */
export async function reapGroup(pid: number, timeoutMs = 2000): Promise<boolean> {
  signalGroup(pid, "SIGKILL");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
