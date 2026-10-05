/**
 * Name of the daemon's npm package, as installed (05, section 2). The workspace calls it
 * `@orchestrator/daemon`; the package the server serves is built under this name by
 * `apps/daemon/scripts/pack.ts`, and the update commands name it.
 */
export const DAEMON_PACKAGE_NAME = 'orchestrator-daemon';

/** File name of the daemon package of one version, served at `/downloads/` (05, section 2). */
export function daemonPackageFileName(version: string): string {
  return `${DAEMON_PACKAGE_NAME}-${version}.tgz`;
}

/**
 * The commands updating a daemon installed as the service to the package a server serves, one per
 * line, as Help > Machines > "Update the daemon" gives them (05, section 2; the commands that
 * worked on 2026-10-03). `--prefer-online` makes npm download the package again: a package of the
 * same version number can hold another build.
 */
export function daemonUpdateCommands(serverAddress: string, version: string): string[] {
  const base = serverAddress.replace(/\/+$/, '');
  return [
    `systemctl --user stop ${DAEMON_PACKAGE_NAME}`,
    `npm uninstall -g ${DAEMON_PACKAGE_NAME}`,
    `npm install -g --prefer-online ${base}/downloads/${daemonPackageFileName(version)}`,
    `${DAEMON_PACKAGE_NAME} install-service`,
    `${DAEMON_PACKAGE_NAME} doctor`,
  ];
}
