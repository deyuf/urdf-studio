// The Source tab shows the expanded URDF for xacro documents. Saving that
// text back over the .xacro would replace its macros, includes and args
// with flattened output, so hosts route xacro saves to a separate .urdf.

export function isXacroPath(filePath: string): boolean {
  return /\.xacro$/i.test(filePath);
}

/** `arm.urdf.xacro` / `arm.xacro` → `arm.urdf`; other names get `.urdf` appended once. */
export function expandedUrdfName(fileName: string): string {
  const stem = fileName.replace(/(\.urdf)?\.xacro$/i, '').replace(/\.urdf$/i, '');
  return `${stem || 'robot'}.urdf`;
}
