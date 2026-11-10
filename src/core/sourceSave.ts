// The Source tab shows generated URDF for xacro (expanded) and MJCF
// (converted) documents. Saving that text back over the original would
// replace the author's source, so hosts route those saves to a separate
// .urdf file.

/** Documents whose Source tab text is generated rather than the file itself. */
export function isGeneratedSourcePath(filePath: string): boolean {
  return /\.(xacro|xml|mjcf)$/i.test(filePath);
}

/** `arm.urdf.xacro` / `arm.xacro` / `arm.xml` → `arm.urdf`; other names get `.urdf` once. */
export function expandedUrdfName(fileName: string): string {
  const stem = fileName.replace(/(\.urdf)?\.(xacro|xml|mjcf)$/i, '').replace(/\.urdf$/i, '');
  return `${stem || 'robot'}.urdf`;
}
