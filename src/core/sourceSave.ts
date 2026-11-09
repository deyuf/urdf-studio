// Shared rules for saving the Source tab.
//
// For a xacro document the Source tab shows the *expanded* URDF. Writing that
// text back over the .xacro would silently destroy its macros, properties,
// includes and args, so hosts must never do it: they save (VS Code) or
// download (browser) the expansion as a separate `.urdf` file instead.

/** True when `filePath` names xacro source (case-insensitive, any directory). */
export function isXacroPath(filePath: string): boolean {
  return /\.xacro$/i.test(filePath);
}

/**
 * File name for the expanded URDF of a xacro file:
 * `robot.urdf.xacro` → `robot.urdf`, `robot.xacro` → `robot.urdf`.
 * Non-xacro names are returned unchanged.
 */
export function expandedUrdfFileName(fileName: string): string {
  if (!isXacroPath(fileName)) {
    return fileName;
  }
  const stem = fileName.replace(/(\.urdf)?\.xacro$/i, '');
  return `${stem || 'robot'}.urdf`;
}
