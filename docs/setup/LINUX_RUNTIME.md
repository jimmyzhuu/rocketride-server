# Linux runtime requirements (for the downloaded engine)

The RocketRide engine binary distributed via the VS Code extension (or downloaded directly from GitHub releases) is **dynamically linked** against the system C++ runtime on Linux. The tarball does not bundle these libraries, so they must be present on your machine before the engine can start.

If they are missing, you will see an error similar to:

```
./engine: error while loading shared libraries: libc++.so.1: cannot open shared object file: No such file or directory
```

Or, under `qemu-user` emulation:

```
x86_64-binfmt-P: Could not open '/lib64/ld-linux-x86-64.so.2': No such file or directory
```

## Required libraries

| Library          | Provided by (Debian/Ubuntu package) | Purpose                                  |
| ---------------- | ----------------------------------- | ---------------------------------------- |
| `libc++.so.1`    | `libc++1`                           | LLVM C++ standard library (used by Clang builds) |
| `libc++abi.so.1` | `libc++abi1`                        | C++ ABI runtime (exception handling, RTTI) |
| `libgomp.so.1`   | `libgomp1`                          | OpenMP runtime (used by some pipeline nodes) |

`libc.so.6` and the dynamic loader (`/lib64/ld-linux-x86-64.so.2`) are part of every Linux distribution and require no separate install.

## Install commands by distribution

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y libc++1 libc++abi1 libgomp1
```

### Fedora / RHEL / Rocky / Alma

```bash
sudo dnf install -y libcxx libcxxabi libgomp
```

### Arch / Manjaro

```bash
sudo pacman -S --needed libc++ libc++abi gcc-libs
```

### openSUSE

```bash
sudo zypper install -y libc++1 libc++abi1 libgomp1
```

### Alpine

The downloaded engine is built against glibc, not musl, so it does **not** run on stock Alpine. Use the Docker image instead (which ships its own runtime), or build the engine from source against musl.

## Automatic detection in the VS Code extension

Starting with version 1.1.x, the RocketRide extension runs `ldd` against the engine right after every install and shows a blocking modal if any of the libraries above are missing. The modal has two buttons:

| Action                       | What it does                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Install System Dependency** | Picks the best elevation mechanism for your environment. On a desktop Linux with PolicyKit (GNOME/KDE), shows the native GUI password dialog and installs in the background with a progress notification. On WSL, Remote-SSH, dev containers, or minimal distros, opens an integrated terminal with the install command pre-typed for you to review and run. Either way, the password never passes through the extension. |
| **Learn More**               | Opens this page so you can install manually, check what each package does, or pick the right command for a distro the extension can't auto-handle.                                                                                                                                                            |

The install command matches your distribution automatically — `apt` on Debian/Ubuntu, `dnf` on Fedora/RHEL, `pacman` on Arch/Manjaro, `zypper` on openSUSE. If your distribution isn't recognized, the modal falls back to listing the missing libraries plus a link here.

The modal is **blocking** because the engine cannot start without these libraries. Its detail line spells out the consequence of cancelling and includes the exact manual command for later use. If you do cancel, a follow-up notification surfaces the same command with a "Copy Command" button so you can re-run it from any shell.

### About sudo and passwords

The extension never reads, stores, or transmits your password. There are two elevation paths and both keep the password out of Node.js:

- **PolicyKit (`pkexec`)** — your desktop environment shows its native authentication dialog. `pkexec` runs the install as root after authorization; the password is handled entirely by `polkitd` and never touches the extension process. The install runs silently with a VS Code progress notification, then you get a success or error toast.
- **Terminal fallback** — an integrated terminal opens with the `sudo apt …` command pre-typed (not executed). You review the command, edit it if you want, and press Enter. `sudo` then prompts for your password directly on the terminal's TTY, exactly as if you had typed the command yourself.

If your account isn't in the sudoers file, the modal says so upfront and recommends contacting an administrator with the command instead of offering an install button that would just produce a permission error.

## Verifying manually with ldd

You can also run the check by hand at any time:

```bash
# The path depends on the extension version; check ~/.config/RocketRide/engine/
ldd ~/.config/RocketRide/engine/engine | grep "not found"
```

If the command prints nothing, all libraries are resolved and the engine should start. Any line ending in `not found` is a missing dependency — install the corresponding package from the table above.

## Why isn't this bundled into the tarball?

Three reasons:

1. **Size** — bundling `libc++`, `libc++abi`, `libgomp`, plus a working glibc family (loader + `libc.so.6`, `libm.so.6`, …) adds ~30 MB to every release artifact.
2. **Security patching** — the system libraries get updates from your distribution's security tracker. A bundled copy would freeze whatever version was on the build runner at release time.
3. **Standard Linux convention** — Linux applications normally depend on the system runtime. The three libraries listed above are widely available, well-known packages — not exotic dependencies.

If you are running the engine in a sandboxed environment where you can't `apt install`, use the [Docker image](https://github.com/rocketride-org/rocketride-server/blob/develop/docker/Dockerfile.engine) instead — it ships with the runtime pre-installed.

## Building from source

If you compile the engine yourself with `./builder server:build`, the build toolchain (`clang`, `libc++-*-dev`) brings the runtime libraries in transitively, so this page does not apply. See [docs/setup/README.md](./README.md) for the source build prerequisites.
