import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type WmpStatus = {
  id: string;
  title: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  isPaused: boolean;
};

type BridgeResponse = Partial<WmpStatus> & {
  requestId?: number;
  ok: boolean;
  error?: string;
};

type PendingRequest = {
  resolve: (response: BridgeResponse) => void;
  timeout: NodeJS.Timeout;
};

export class WmpBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 0;

  public initialize(): void {
    if (process.platform !== "win32" || this.child) return;

    const scriptPath = fileURLToPath(
      new URL("./wmpAutomationHost.ps1", import.meta.url),
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Sta",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        scriptPath,
      ],
      { windowsHide: true },
    );

    this.child = child;
    child.stderr.on("data", () => undefined);

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as BridgeResponse;
        if (response.requestId == null) return;

        const pending = this.pending.get(response.requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pending.delete(response.requestId);
        pending.resolve(response);
      } catch {
        // Ignore PowerShell diagnostics that are not protocol responses.
      }
    });

    child.once("exit", () => this.handleExit(child));
    child.once("error", () => this.handleExit(child));
  }

  public async getStatus(): Promise<WmpStatus | null> {
    const response = await this.request("status");
    if (!response.ok || !response.id || !response.title) return null;

    return {
      id: response.id,
      title: response.title,
      artist: response.artist || "",
      album: response.album || "",
      positionMs: Math.max(0, response.positionMs || 0),
      durationMs: Math.max(0, response.durationMs || 0),
      isPlaying: Boolean(response.isPlaying),
      isPaused: Boolean(response.isPaused),
    };
  }

  public async command(
    command: "play" | "pause" | "stop" | "next" | "previous" | "seek",
    positionMs?: number,
  ): Promise<boolean> {
    return (await this.request(command, positionMs)).ok;
  }

  public stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
    this.resolvePending("bridge_stopped");
  }

  private request(
    command: string,
    positionMs?: number,
  ): Promise<BridgeResponse> {
    this.initialize();
    const child = this.child;
    if (!child?.stdin.writable) return Promise.resolve({ ok: false });

    const requestId = ++this.nextRequestId;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "bridge_timeout" });
      }, 2000);

      this.pending.set(requestId, { resolve, timeout });
      child.stdin.write(
        `${JSON.stringify({ requestId, command, positionMs })}\n`,
      );
    });
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) this.child = undefined;
    this.resolvePending("bridge_stopped");
  }

  private resolvePending(error: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
  }
}
