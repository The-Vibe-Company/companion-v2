import type {
  BoxLabDriver,
  DriverCommandInput,
  DriverCommandResult,
  DriverDoctorCheck,
} from "../src/driver";

interface FakeResource {
  running: boolean;
  files: Map<string, Buffer>;
}

export class FakeDriver implements BoxLabDriver {
  readonly kind = "oci-systemd" as const;
  readonly resources = new Map<string, FakeResource>();
  readonly snapshots = new Map<string, Map<string, Buffer>>();
  readonly commands: DriverCommandInput[] = [];
  resetCount = 0;

  async doctor(): Promise<DriverDoctorCheck[]> {
    return [{ name: "fake", ok: true, detail: "contained fake driver" }];
  }

  async prepare(): Promise<void> {}

  async create(resourceName: string, fromSnapshotResourceName?: string): Promise<void> {
    if (this.resources.has(resourceName)) throw new Error("duplicate fake resource");
    const source = fromSnapshotResourceName ? this.snapshots.get(fromSnapshotResourceName) : undefined;
    if (fromSnapshotResourceName && !source) throw new Error("missing fake snapshot");
    this.resources.set(resourceName, {
      running: true,
      files: new Map([...(source ?? new Map()).entries()].map(([path, bytes]) => [path, Buffer.from(bytes)])),
    });
  }

  async writeFile(resourceName: string, relativePath: string, content: Uint8Array): Promise<void> {
    const resource = this.resources.get(resourceName);
    if (!resource?.running) throw new Error("fake resource is not running");
    resource.files.set(relativePath, Buffer.from(content));
  }

  async execute(input: DriverCommandInput): Promise<DriverCommandResult> {
    const resource = this.resources.get(input.resourceName);
    if (!resource?.running) throw new Error("fake resource is not running");
    this.commands.push(structuredClone(input));
    return {
      success: true,
      exitCode: 0,
      stdout: `${input.command}\n`,
      stderr: "",
      timedOut: false,
    };
  }

  async stop(resourceName: string): Promise<void> {
    const resource = this.resources.get(resourceName);
    if (!resource) throw new Error("missing fake resource");
    resource.running = false;
  }

  async start(resourceName: string): Promise<void> {
    const resource = this.resources.get(resourceName);
    if (!resource) throw new Error("missing fake resource");
    resource.running = true;
  }

  async delete(resourceName: string): Promise<void> {
    this.resources.delete(resourceName);
  }

  async saveSnapshot(resourceName: string, snapshotResourceName: string): Promise<void> {
    const resource = this.resources.get(resourceName);
    if (!resource) throw new Error("missing fake resource");
    this.snapshots.set(
      snapshotResourceName,
      new Map([...resource.files.entries()].map(([path, bytes]) => [path, Buffer.from(bytes)])),
    );
  }

  async deleteSnapshot(snapshotResourceName: string): Promise<void> {
    this.snapshots.delete(snapshotResourceName);
  }

  async interactiveShell(): Promise<number> {
    return 0;
  }

  async reset(): Promise<void> {
    this.resources.clear();
    this.snapshots.clear();
    this.resetCount += 1;
  }
}
