import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
const clientMocks = vi.hoisted(() => ({
  getClient: vi.fn(async () => ({ request: requestMock })),
}));
const credentialMocks = vi.hoisted(() => ({
  agentCredentialsPath: vi.fn(() => "/tmp/agent.json"),
  loadAgentCredentials: vi.fn(),
  removeAgentCredentials: vi.fn(),
  saveAgentCredentials: vi.fn(),
}));
const serviceMocks = vi.hoisted(() => ({
  installService: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
  supportsServiceManagement: vi.fn(),
  uninstallService: vi.fn(),
}));

vi.mock("../lib/client", () => clientMocks);
vi.mock("../agent/credentials", () => credentialMocks);
vi.mock("../agent/daemon", () => ({ runAgentDaemon: vi.fn() }));
vi.mock("../agent/lock", () => ({ currentAgentPid: vi.fn(async () => null) }));
vi.mock("../agent/statusFile", () => ({ readAgentStatus: vi.fn(async () => null) }));
vi.mock("../agent/service", () => serviceMocks);

import { install } from "./agent";

const globals = { profile: "default", json: true };
let stdoutSpy: { mockRestore: () => void } | null = null;

describe("agent command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    serviceMocks.supportsServiceManagement.mockReturnValue(true);
    requestMock.mockResolvedValue({
      device_id: "device-1",
      device_token: "cmp_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      org_id: "org-1",
      api_url: "http://127.0.0.1:3001",
    });
  });

  afterEach(() => {
    stdoutSpy?.mockRestore();
    stdoutSpy = null;
  });

  it("does not register a remote device before unsupported service installs fail", async () => {
    serviceMocks.supportsServiceManagement.mockReturnValue(false);

    await expect(install({}, globals)).rejects.toThrow("Use: companion agent install --no-service");

    expect(clientMocks.getClient).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(credentialMocks.saveAgentCredentials).not.toHaveBeenCalled();
  });

  it("allows no-service installs on platforms without service management", async () => {
    serviceMocks.supportsServiceManagement.mockReturnValue(false);

    await install({ noService: true }, globals);

    expect(requestMock).toHaveBeenCalledWith(
      "/v1/agent/devices",
      expect.objectContaining({ method: "POST" }),
    );
    expect(credentialMocks.saveAgentCredentials).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "device-1" }));
    expect(serviceMocks.installService).not.toHaveBeenCalled();
  });
});
