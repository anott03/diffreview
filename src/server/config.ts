import { Context } from "effect";

export interface ServerOptions {
  port: number;
  intervalMs: number;
  webRoot: string | null;
  instanceId: string;
  startedAt: number;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerOptions>()("diffreview/server/ServerConfig") {}

export interface ProjectOptions {
  projectId: string;
  repoRoot: string;
  dbPath: string;
  intervalMs: number;
}

export class ProjectConfig extends Context.Service<ProjectConfig, ProjectOptions>()("diffreview/server/ProjectConfig") {}
