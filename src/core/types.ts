export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface StudioDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  code?: string;
  target?: string;
  file?: string;
  line?: number;
}

export interface PackageEntry {
  name: string;
  path: string;
  packageXml: string;
}

export type PackageMap = Record<string, PackageEntry>;

export interface JointLimit {
  lower?: number;
  upper?: number;
  effort?: number;
  velocity?: number;
}

export interface JointInfo {
  name: string;
  type: string;
  parent?: string;
  child?: string;
  axis: [number, number, number];
  limit: JointLimit;
  line?: number;
}

export interface MeshInfo {
  link: string;
  kind: 'visual' | 'collision';
  filename: string;
  packageName?: string;
  resolvedPath?: string;
  exists: boolean;
  line?: number;
}

export interface LinkInfo {
  name: string;
  parentJoint?: string;
  childJoints: string[];
  line?: number;
}

export interface LinkTreeNode {
  link: string;
  joint?: string;
  children: LinkTreeNode[];
}

export interface RobotMetadata {
  robotName: string;
  counts: {
    links: number;
    joints: number;
    movableJoints: number;
    visualMeshes: number;
    collisionMeshes: number;
  };
  links: Record<string, LinkInfo>;
  joints: Record<string, JointInfo>;
  meshes: MeshInfo[];
  rootLinks: string[];
  movableJointNames: string[];
  tree: LinkTreeNode[];
  diagnostics: StudioDiagnostic[];
}

export interface SemanticGroup {
  name: string;
  joints: string[];
}

export interface SemanticState {
  name: string;
  group: string;
  joints: Record<string, number>;
}

export interface SemanticMetadata {
  groups: SemanticGroup[];
  states: SemanticState[];
  diagnostics: StudioDiagnostic[];
}

export interface CameraSnapshot {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

export interface PreviewState {
  pose?: Record<string, number>;
  camera?: CameraSnapshot;
}

export interface XacroArgument {
  name: string;
  defaultValue?: string;
}

export interface RenderedRobotDocument {
  sourcePath: string;
  format: 'urdf' | 'xacro';
  urdf: string;
  xacroArgs: XacroArgument[];
  diagnostics: StudioDiagnostic[];
}

