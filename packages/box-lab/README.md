# `@companion/box-lab`

Box Lab implements the Box v1 surface used by `@companion/box-runtime` on top of a contained, real
Linux system. It is deliberately separate from `@companion/box-sim`: the simulator remains safe and
fast, while this package is allowed to run the generated Pi installation script inside a disposable
VM or systemd container. Box Lab is local-only and intentionally slow, so run it as the final local
validation after the fast simulator and ordinary test suites have passed. It does not run in CI.

The default macOS backend is Lima/QEMU. Lima/QEMU is also available explicitly on Linux `x86_64`;
the default Linux backend is `oci-systemd`.
Both execute host processes with an argument vector and `shell: false`; provider commands are passed
to `bash -lc` only after entering the contained Box.

## Prerequisites

Box Lab never installs host tooling automatically. On macOS, install Lima, QEMU, and the Linux
`x86_64` guest agent, then let the doctor verify all three:

```sh
brew install lima qemu lima-additional-guestagents
pnpm box:lab:doctor
```

The guest architecture is deliberately `x86_64`. Apple Silicon therefore uses QEMU emulation and is
substantially slower than a native-architecture VM. See Lima's
[multi-architecture documentation](https://lima-vm.io/docs/config/multi-arch/).

On a Linux `x86_64` development host, the matching Lima release already includes its native
`x86_64` guest agent. Install Lima 2.2 or newer and `qemu-system-x86_64` using the host's package
manager or Lima's [official installation instructions](https://lima-vm.io/docs/installation/), then
select the VM backend explicitly:

```sh
BOX_LAB_DRIVER=lima pnpm box:lab:doctor
BOX_LAB_DRIVER=lima pnpm box:lab:smoke
```

This Linux Lima path is the fallback when local OCI systemd cannot boot on the host.

The `oci-systemd` backend requires Linux `x86_64`, Docker, and permission to start privileged,
disposable containers. A Linux developer machine builds its pinned image on the first smoke. It runs
systemd as PID 1 inside the container and never invokes the host service manager.

The doctor also verifies that the current process belongs to a cgroup v2 `domain`. Nested sandboxes
whose current cgroup is `threaded` or `domain invalid` cannot boot a contained systemd even when
Docker is installed; use the explicit Lima driver on a Linux `x86_64` host in that case.

```sh
BOX_LAB_DRIVER=oci-systemd pnpm box:lab:doctor
BOX_LAB_DRIVER=oci-systemd pnpm box:lab:smoke
```

```sh
pnpm box:lab:doctor
pnpm box:lab:smoke
pnpm box:lab:smoke -- --scenario bundle
pnpm box:lab:smoke -- --profile real-provider
pnpm box:lab:shell bx_23456789
pnpm box:lab:reset
```

Run these smokes only after the faster relevant checks have passed. The first cold install and the
full lifecycle can take several minutes, especially when Apple Silicon emulates `x86_64` through
QEMU.

The bundle scenario builds its archive inside Linux through the Box API, then feeds its checksum and
guest-local URL to the production layout generator. It does not accept or mount a host-built bundle.

The optional real-provider profile is local-only. Supply exactly one Pi provider credential and the
matching Pi model id for a single invocation:

```sh
BOX_LAB_REAL_PROVIDER_AUTH_JSON='{"provider-id":{"type":"api_key","key":"replace-me"}}' \
BOX_LAB_REAL_PROVIDER_MODEL_ID='provider-model-id' \
pnpm box:lab:smoke -- --profile real-provider
```

The real-provider profile never writes credential values to diagnostics and attempts cleanup after
both success and failure.

`BOX_LAB_HOST` accepts loopback only. State and expurgated diagnostics live under the workspace's
root `.context/box-lab/`; the root `pnpm box:lab:*` commands set that path before entering the
workspace package. State and OCI labels use the bounded workspace scope. Lima and OCI resource names
use a short, stable digest of the exact workspace id so Lima's Unix socket paths remain below the
host limit. Reset matches only those identifiers and never calls a global prune. Successful smokes
clean up automatically; failed deterministic local smokes retain the scoped Box and print the
complete shell command needed to inspect it.

The v1 Lab intentionally returns `unsupported_surface` for desktop and hosted/direct transport.
