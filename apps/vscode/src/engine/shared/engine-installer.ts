// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-installer.ts — Engine Download and Installation
 *
 * Downloads engine releases from GitHub, extracts them into a single `engine/`
 * directory, and tracks the installed version via a version file (e.g., `version.local.json`).
 *
 * Only one engine version exists on disk at a time. Installing a new version
 * replaces the previous one. The engine executable path is always fixed at
 * `<parentDir>/engine/engine(.exe)` — callers never need to update paths
 * when switching versions.
 *
 * Uses a cross-process lockfile so multiple VS Code windows can safely share
 * the same engine directory. No process management or connection state —
 * that belongs to EngineManager.
 *
 * Directory layout:
 *   <parentDir>/engine/
 *     engine.exe | engine           — engine binary
 *     ai/eaas.py                    — Python entrypoint
 *   <parentDir>/version.*.json        — { tag, publishedAt } installed version
 *     install.lock                  — cross-process lockfile
 *     engine-<pid>.pid              — written by EngineManager per running process
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as lockfile from 'proper-lockfile';
import { execFile, execFileSync } from 'child_process';
import { getLogger } from '../../shared/util/output';
import { icons } from '../../shared/util/icons';

// =============================================================================
// TYPES
// =============================================================================

/** GitHub release asset metadata. */
interface ReleaseAsset {
	id: number;
	name: string;
	browser_download_url: string;
	size: number;
}

/** GitHub release metadata (tag, date, assets). */
interface ReleaseInfo {
	tag_name: string;
	published_at: string;
	assets: ReleaseAsset[];
}

/** Item in the version picker dropdown. */
export interface ReleaseListItem {
	tag_name: string;
	prerelease: boolean;
}

/** Platform-specific archive naming. */
interface PlatformInfo {
	name: string;
	ext: string;
}

/** Contents of the version tracking file (e.g., version.local.json). */
interface InstalledVersion {
	tag: string;
	publishedAt: string;
}

// =============================================================================
// ENGINE INSTALLER
// =============================================================================

/**
 * EngineInstaller — downloads, installs, and manages a single engine version.
 *
 * Only one version exists on disk at a time in the `engine/` subdirectory.
 * Installing a new version replaces the old one. The executable path is
 * always `<parentDir>/engine/engine(.exe)`.
 */
export class EngineInstaller {
	private static readonly GITHUB_OWNER = 'rocketride-org';
	private static readonly GITHUB_REPO = 'rocketride-server';

	/** The engine/ directory (e.g., C:\ProgramData\RocketRide\engine). */
	private readonly engineDir: string;

	/** The parent directory (e.g., C:\ProgramData\RocketRide). */
	private readonly parentDir: string;

	/** Filename for version tracking (e.g., 'version.local.json'). */
	private readonly versionFileName: string;

	private readonly logger = getLogger();

	/**
	 * @param parentDir - Parent directory. The engine will be installed
	 *   into a `engine/` subdirectory of this path.
	 * @param versionFileName - Name of the version tracking file, stored in
	 *   parentDir (not inside engine/ — survives engine dir clears).
	 *   Defaults to 'version.json'.
	 */
	constructor(parentDir: string, versionFileName: string = 'version.json') {
		this.parentDir = parentDir;
		this.engineDir = path.join(parentDir, 'engine');
		this.versionFileName = versionFileName;
	}

	// =========================================================================
	// PATHS
	// =========================================================================

	/** Returns the engine/ directory path. */
	get dir(): string {
		return this.engineDir;
	}

	/** Returns the platform-specific executable filename (engine.exe or engine). */
	private executableName(): string {
		return process.platform === 'win32' ? 'engine.exe' : 'engine';
	}

	/** Returns the full path to the engine executable. */
	public getExecutablePath(): string {
		return path.join(this.engineDir, this.executableName());
	}

	/**
	 * Path to the cross-process lockfile in the parent directory (not inside
	 * engine/ — that gets cleared during install). proper-lockfile creates a
	 * <file>.lock directory next to this file as its locking mechanism.
	 */
	private lockFilePath(): string {
		return path.join(path.dirname(this.engineDir), '.installing');
	}

	/** Path to the version tracking file in the parent directory. */
	private versionJsonPath(): string {
		return path.join(this.parentDir, this.versionFileName);
	}

	/** Creates the parent dir, engine/ subdir, and lockfile if they don't exist. */
	private ensureEngineDir(): void {
		fs.mkdirSync(this.engineDir, { recursive: true });
		const lockPath = this.lockFilePath();
		if (!fs.existsSync(lockPath)) {
			fs.mkdirSync(path.dirname(lockPath), { recursive: true });
			fs.writeFileSync(lockPath, '', 'utf8');
		}
	}

	// =========================================================================
	// PUBLIC API
	// =========================================================================

	/** Returns true if an engine executable exists on disk. */
	public isInstalled(): boolean {
		return fs.existsSync(this.getExecutablePath());
	}

	/**
	 * Reads version file from the engine directory.
	 * Returns null if no engine is installed or the file is missing/corrupt.
	 */
	public getInstalledVersion(): InstalledVersion | null {
		try {
			const p = this.versionJsonPath();
			if (fs.existsSync(p)) {
				// Verify the engine binary actually exists — version file alone
				// can be a leftover from a partial uninstall
				if (!fs.existsSync(this.getExecutablePath())) return null;
				return JSON.parse(fs.readFileSync(p, 'utf8')) as InstalledVersion;
			}
		} catch {
			// Corrupt or unreadable — treat as unknown version
		}
		return null;
	}

	/**
	 * Ensures the engine is installed at the requested version. Downloads if
	 * needed, replacing the current engine/ contents.
	 *
	 * Uses a cross-process lockfile so multiple VS Code windows coordinate safely.
	 * Returns the path to the engine executable (always the same fixed path).
	 *
	 * @param versionSpec - 'latest', 'prerelease', or a specific tag (e.g., 'server-3.2.0')
	 * @param progress - Progress reporter for UI feedback
	 * @param token - Cancellation token
	 * @param githubToken - Optional GitHub token for higher API rate limits
	 */
	public async install(
		versionSpec: string = 'latest',
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		this.logger.output(`${icons.info} Engine version requested: ${displaySpec}`);

		// Ensure engine directory and lockfile exist
		this.ensureEngineDir();

		// Acquire cross-process lock (blocking — waits for other windows)
		progress?.report({ message: 'Waiting for engine lock...' });
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 120000,
				retries: { retries: 30, minTimeout: 2000, maxTimeout: 5000 },
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to acquire engine install lock: ${msg}`);
		}

		try {
			const exePath = await this.installUnderLock(versionSpec, progress, token, githubToken);
			// Run the runtime-dep check on EVERY install attempt, not just fresh
			// downloads. installUnderLock has three return paths (fresh download,
			// "already up to date" short-circuit, GitHub-unreachable fallback);
			// users whose engine was installed before this check existed only hit
			// the latter two, so putting the check here is the only way to reach
			// them without forcing a manual uninstall+reinstall.
			this.checkLinuxRuntimeDeps(exePath);
			return exePath;
		} finally {
			try { await release(); } catch { /* ignore stale lock */ }
		}
	}

	/**
	 * Removes the entire engine/ directory.
	 * Uses the cross-process lock to prevent races.
	 */
	public async uninstall(): Promise<void> {
		this.ensureEngineDir();
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 120000,
				retries: { retries: 5, minTimeout: 1000, maxTimeout: 3000 },
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to acquire engine lock for uninstall: ${msg}`);
		}
		try {
			if (fs.existsSync(this.engineDir)) {
				fs.rmSync(this.engineDir, { recursive: true, force: true });
				this.logger.output(`${icons.info} Engine uninstalled from ${this.engineDir}`);
			}
		} finally {
			try { await release(); } catch { /* ignore stale lock */ }
		}
	}

	// =========================================================================
	// INSTALL LOGIC (under lock)
	// =========================================================================

	/**
	 * Core install logic — runs inside the cross-process lock.
	 *
	 * 1. Fetch the target release from GitHub
	 * 2. Compare tag against installed version file — skip if same
	 * 3. Clear engine/ contents (preserve lockfile and PID files)
	 * 4. Extract new archive into engine/
	 * 5. Write version file
	 */
	private async installUnderLock(
		versionSpec: string,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		const exePath = this.getExecutablePath();
		const installed = this.getInstalledVersion();

		// --- Resolve the target release ---
		let releaseInfo: ReleaseInfo;
		try {
			progress?.report({ message: 'Checking for updates...' });
			releaseInfo = await this.fetchRelease(versionSpec, token, githubToken);
		} catch {
			// GitHub unreachable — use what's already installed if we have it
			if (installed && fs.existsSync(exePath)) {
				this.logger.output(`${icons.info} Could not check for updates, using installed version`);
				return exePath;
			}
			throw new Error(`No engine installed and cannot reach GitHub to download ${displaySpec}`);
		}

		// --- Already up to date? ---
		if (installed && installed.tag === releaseInfo.tag_name && fs.existsSync(exePath)) {
			const displayTag = releaseInfo.tag_name.replace(/^server-/, '');
			this.logger.output(`${icons.success} Engine ${displayTag} already installed`);
			return exePath;
		}

		// --- Download and install ---
		return this.downloadAndInstall(releaseInfo, progress, token, githubToken);
	}

	// =========================================================================
	// DOWNLOAD AND EXTRACT
	// =========================================================================

	/**
	 * Downloads a release archive, clears the engine directory, extracts the
	 * new version, writes version file, and returns the executable path.
	 */
	private async downloadAndInstall(
		release: ReleaseInfo,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displayVersion = release.tag_name.replace(/^server-/, '');

		// Find the correct asset for this platform
		const asset = this.findPlatformAsset(release);
		this.logger.output(`${icons.info} Found release ${displayVersion}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

		// Download to a temp file
		const tmpPath = path.join(os.tmpdir(), `rocketride-engine-${Date.now()}${asset.name.endsWith('.zip') ? '.zip' : '.tar.gz'}`);

		try {
			progress?.report({ message: `Downloading ${displayVersion}...` });
			await this.downloadAsset(asset, tmpPath, displayVersion, progress, token, githubToken);
			this.throwIfCancelled(token);

			// Clear existing engine contents (preserve lockfile and PID files)
			this.clearEngineDir();

			// Extract into engine/
			fs.mkdirSync(this.engineDir, { recursive: true });
			progress?.report({ message: 'Extracting server...' });
			await this.extractArchive(tmpPath, this.engineDir);

			// Set executable permissions on Unix
			const exePath = this.getExecutablePath();
			if (process.platform !== 'win32' && fs.existsSync(exePath)) {
				fs.chmodSync(exePath, 0o755);
			}

			// Verify the executable exists
			if (!fs.existsSync(exePath)) {
				throw new Error(`Engine extraction completed but executable not found at: ${exePath}`);
			}

			// (Runtime dep check runs in install() after this returns, so it
			// covers fresh downloads AND "already installed" short-circuits.)

			// Write version file so we know what's installed
			this.writeVersionJson({ tag: release.tag_name, publishedAt: release.published_at });

			this.logger.output(`${icons.success} Server ${release.tag_name} installed at ${this.engineDir}`);
			progress?.report({ message: 'Server ready!' });

			return exePath;
		} finally {
			// Clean up temp file
			try {
				if (fs.existsSync(tmpPath)) {
					fs.unlinkSync(tmpPath);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
	}

	/**
	 * Removes all files from engine/ except install.lock and PID files.
	 * Called before extracting a new version.
	 */
	private clearEngineDir(): void {
		if (!fs.existsSync(this.engineDir)) return;

		for (const entry of fs.readdirSync(this.engineDir, { withFileTypes: true })) {
			// Keep PID files for processes that are still alive
			if (entry.name.endsWith('.pid')) {
				try {
					const pidStr = fs.readFileSync(path.join(this.engineDir, entry.name), 'utf8').trim();
					const pid = parseInt(pidStr, 10);
					if (!isNaN(pid) && isPidAlive(pid)) continue;
				} catch { /* stale — allow removal */ }
			}

			const fullPath = path.join(this.engineDir, entry.name);
			try {
				fs.rmSync(fullPath, { recursive: true, force: true });
			} catch {
				// EBUSY on Windows — binary may be locked by a running process
				this.logger.output(`${icons.warning} Could not remove ${entry.name} (may be in use)`);
			}
		}
	}

	/** Writes version file into the engine directory. */
	private writeVersionJson(version: InstalledVersion): void {
		fs.writeFileSync(this.versionJsonPath(), JSON.stringify(version, null, 2), 'utf8');
	}

	// =========================================================================
	// GITHUB API
	// =========================================================================

	/**
	 * Fetches all available releases for the version dropdown.
	 * Returns server-tagged releases with assets, sorted newest first.
	 */
	public async getReleases(
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<ReleaseListItem[]> {
		this.throwIfCancelled(token);
		const octokit = await this.createOctokit(githubToken);
		const { data } = await octokit.repos.listReleases({
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			per_page: 100
		});
		return data
			.filter(r => r.tag_name?.startsWith('server-') && !r.prerelease && r.assets && r.assets.length > 0)
			.map(r => ({
				tag_name: r.tag_name,
				prerelease: r.prerelease
			}));
	}

	/** Creates an authenticated (or anonymous) Octokit instance. */
	private async createOctokit(githubToken?: string) {
		const { Octokit } = await import('@octokit/rest');
		return new Octokit({
			auth: githubToken,
			userAgent: 'RocketRide-VSCode'
		});
	}

	/**
	 * Fetches a specific release based on version spec.
	 * - 'latest': newest non-prerelease with assets
	 * - 'prerelease': newest prerelease with assets
	 * - specific tag (e.g., 'server-3.2.0'): exact release by tag
	 */
	private async fetchRelease(
		versionSpec: string,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<ReleaseInfo> {
		this.throwIfCancelled(token);
		const octokit = await this.createOctokit(githubToken);

		if (versionSpec === 'latest') {
			const { data } = await octokit.repos.listReleases({
				owner: EngineInstaller.GITHUB_OWNER,
				repo: EngineInstaller.GITHUB_REPO,
				per_page: 20
			});
			const stable = data.find(r => r.tag_name.startsWith('server-') && !r.prerelease && r.assets && r.assets.length > 0);
			if (!stable) throw new Error('No stable server releases found on GitHub');
			return this.toReleaseInfo(stable);
		}

		if (versionSpec === 'prerelease') {
			const { data } = await octokit.repos.listReleases({
				owner: EngineInstaller.GITHUB_OWNER,
				repo: EngineInstaller.GITHUB_REPO,
				per_page: 20
			});
			const pre = data.find(r => r.tag_name.startsWith('server-') && r.prerelease && r.assets && r.assets.length > 0);
			if (!pre) throw new Error('No prerelease server releases found on GitHub');
			return this.toReleaseInfo(pre);
		}

		// Specific tag
		const { data } = await octokit.repos.getReleaseByTag({
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			tag: versionSpec
		});
		return this.toReleaseInfo(data);
	}

	/** Converts raw GitHub release data to our ReleaseInfo type. */
	private toReleaseInfo(release: { tag_name: string; published_at?: string | null; assets: Array<{ id: number; name: string; browser_download_url: string; size: number }> }): ReleaseInfo {
		if (!release.tag_name || !release.assets || release.assets.length === 0) {
			throw new Error(`Release ${release.tag_name} has no assets`);
		}
		return {
			tag_name: release.tag_name,
			published_at: release.published_at ?? '',
			assets: release.assets.map(a => ({
				id: a.id,
				name: a.name,
				browser_download_url: a.browser_download_url,
				size: a.size
			}))
		};
	}

	// =========================================================================
	// PLATFORM AND ASSET HELPERS
	// =========================================================================

	/** Returns platform-specific archive naming info. */
	private getPlatformInfo(): PlatformInfo {
		const platform = process.platform;
		const arch = process.arch;

		if (platform === 'win32') return { name: 'win64', ext: 'zip' };
		if (platform === 'darwin') {
			const darwinArch = arch === 'arm64' ? 'arm64' : 'x64';
			return { name: `darwin-${darwinArch}`, ext: 'tar.gz' };
		}
		if (platform === 'linux') return { name: 'linux-x64', ext: 'tar.gz' };

		throw new Error(`Unsupported platform: ${platform} ${arch}. Supported: Windows (x64), macOS (x64/ARM64), Linux (x64).`);
	}

	/** Finds the matching asset for this platform in a release. */
	private findPlatformAsset(release: ReleaseInfo): ReleaseAsset {
		const info = this.getPlatformInfo();
		const suffix = `-${info.name}.${info.ext}`;
		const asset = release.assets.find(a =>
			a.name.startsWith('rocketride-') && a.name.endsWith(suffix)
		);

		if (!asset) {
			const available = release.assets.map(a => a.name).join(', ');
			throw new Error(`No release asset found for this platform (expected: *${suffix}). Available: ${available}`);
		}

		return asset;
	}

	// =========================================================================
	// DOWNLOAD
	// =========================================================================

	/**
	 * Downloads a release asset with retry logic (up to 15 retries for
	 * 503/504 errors) and progress reporting.
	 */
	private async downloadAsset(
		asset: ReleaseAsset,
		destPath: string,
		displayVersion: string,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<void> {
		const MAX_RETRIES = 15;
		const RETRY_DELAY_MS = 1000;

		const downloadUrl = await this.resolveAssetDownloadUrl(asset, githubToken);

		let response: http.IncomingMessage | undefined;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			this.throwIfCancelled(token);

			response = await this.httpStream(downloadUrl);

			if (!response) throw new Error('No response received');

			if (response.statusCode === 503 || response.statusCode === 504) {
				response.destroy();
				if (attempt < MAX_RETRIES) {
					progress?.report({ message: `Server error (${response.statusCode}), retrying... (${attempt}/${MAX_RETRIES})` });
					await this.delay(RETRY_DELAY_MS);
					continue;
				}
				throw new Error(`Download failed after ${MAX_RETRIES} retries: HTTP ${response.statusCode}`);
			}

			if (response.statusCode !== 200) {
				const statusCode = response.statusCode;
				response.destroy();
				if (statusCode === 403) throw new Error('GitHub API rate limit exceeded. Please try again later.');
				if (statusCode === 404) throw new Error(`Release asset not found: ${asset.name}`);
				throw new Error(`Download failed: HTTP ${statusCode}`);
			}

			break;
		}

		if (!response) throw new Error('No response received after retries');

		// Stream to disk with progress tracking
		const totalBytes = asset.size || parseInt(response.headers['content-length'] || '0', 10);
		let downloadedBytes = 0;
		let lastPercent = -1;

		const tmpDownloadPath = destPath + '.tmp';
		const file = fs.createWriteStream(tmpDownloadPath);

		try {
			await new Promise<void>((resolve, reject) => {
				const onCancel = () => {
					response!.destroy();
					file.close();
					reject(new vscode.CancellationError());
				};

				if (token?.isCancellationRequested) { onCancel(); return; }
				const cancelListener = token?.onCancellationRequested(onCancel);

				response!.on('data', (chunk: Buffer) => {
					downloadedBytes += chunk.length;
					if (totalBytes > 0) {
						const percent = Math.round((downloadedBytes / totalBytes) * 100);
						if (percent !== lastPercent) {
							lastPercent = percent;
							const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
							const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
							progress?.report({ message: `Downloading ${displayVersion}: ${percent}% (${mb}/${totalMb} MB)` });
						}
					}
				});

				response!.pipe(file);
				file.on('finish', () => { file.close(); response!.destroy(); cancelListener?.dispose(); resolve(); });
				file.on('error', (err) => { response!.destroy(); cancelListener?.dispose(); reject(err); });
				response!.on('error', (err) => { response!.destroy(); cancelListener?.dispose(); reject(err); });
			});

			// Verify download completeness
			if (totalBytes > 0) {
				const stat = fs.statSync(tmpDownloadPath);
				if (stat.size !== totalBytes) {
					throw new Error(`Download incomplete: expected ${totalBytes} bytes, got ${stat.size} bytes`);
				}
			}

			fs.renameSync(tmpDownloadPath, destPath);
		} catch (err) {
			try {
				file.close();
				if (fs.existsSync(tmpDownloadPath)) fs.unlinkSync(tmpDownloadPath);
			} catch { /* ignore cleanup errors */ }
			throw err;
		}
	}

	/** Resolves the actual download URL for a release asset (follows redirects). */
	private async resolveAssetDownloadUrl(asset: ReleaseAsset, githubToken?: string): Promise<string> {
		const octokit = await this.createOctokit(githubToken);

		const response = await octokit.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			asset_id: asset.id,
			headers: { accept: 'application/octet-stream' },
			request: { redirect: 'manual' }
		});

		const location = (response as { headers: Record<string, string> }).headers?.location;
		if (location) return location;

		const url = (response as { url?: string }).url;
		if (url) return url;

		return asset.browser_download_url;
	}

	/** Extracts a .zip or .tar.gz archive into the destination directory. */
	private async extractArchive(archivePath: string, destDir: string): Promise<void> {
		if (archivePath.endsWith('.zip')) {
			const AdmZip = require('adm-zip');
			const zip = new AdmZip(archivePath);
			zip.extractAllTo(destDir, true);
		} else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
			const tar = require('tar');
			await tar.extract({ file: archivePath, cwd: destDir });
		} else {
			throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
		}
	}

	/** Opens an HTTP(S) stream, following redirects. */
	private httpStream(url: string): Promise<http.IncomingMessage> {
		return new Promise((resolve, reject) => {
			const protocol = url.startsWith('https') ? https : http;
			const req = protocol.get(url, { headers: { 'User-Agent': 'RocketRide-VSCode' } }, (response) => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					response.destroy();
					this.httpStream(response.headers.location).then(resolve, reject);
					return;
				}
				resolve(response);
			});
			req.on('error', reject);
		});
	}

	/** Throws CancellationError if the token has been cancelled. */
	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) throw new vscode.CancellationError();
	}

	/** Simple delay helper. */
	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// =========================================================================
	// LINUX RUNTIME DEPENDENCY CHECK
	// =========================================================================

	/**
	 * On Linux, runs `ldd` against the freshly extracted engine binary and looks
	 * for missing shared libraries. If any of the known C++ runtime libs are
	 * missing, prompts the user with distro-appropriate install commands.
	 * Non-fatal: install always succeeds — the warning is informational so the
	 * user can fix things before the first engine start fails.
	 */
	private checkLinuxRuntimeDeps(exePath: string): void {
		if (process.platform !== 'linux') return;

		const missingLibs = this.findMissingSharedLibs(exePath);
		if (missingLibs === null) return; // ldd unavailable — best-effort, skip
		if (missingLibs.length === 0) return;

		this.logger.output(`${icons.warning} Engine has missing runtime libraries: ${missingLibs.join(', ')}`);

		const distro = this.detectLinuxDistro();
		if (!distro) {
			// Unknown distro — surface raw lib names and link to docs.
			void this.showUnknownDistroWarning(missingLibs);
			return;
		}

		const packages = missingLibs
			.map(lib => distro.libToPackage[lib])
			.filter((p): p is string => !!p);

		// Dedupe (Arch maps multiple libs → gcc-libs)
		const uniquePackages = Array.from(new Set(packages));

		if (uniquePackages.length === 0) {
			// Libs missing but none we know how to install — surface raw names.
			void this.showUnknownDistroWarning(missingLibs);
			return;
		}

		void this.showLinuxDepsWarning(distro, uniquePackages);
	}

	/**
	 * Runs `ldd` against the binary and returns the list of missing `.so` names.
	 * Returns null if ldd itself failed (binary not exec'able, ldd missing,
	 * etc.) — caller treats null as "skip the check, don't bother the user."
	 */
	private findMissingSharedLibs(exePath: string): string[] | null {
		let lddOutput: string;
		try {
			lddOutput = execFileSync('ldd', [exePath], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.output(`${icons.info} Skipped Linux runtime dep check: ${msg}`);
			return null;
		}

		// ldd lines for missing libs look like: "\tlibc++.so.1 => not found"
		const missing: string[] = [];
		for (const line of lddOutput.split('\n')) {
			if (!line.includes('=> not found')) continue;
			const soMatch = line.trim().match(/^(\S+)\s*=>/);
			if (soMatch && !missing.includes(soMatch[1])) {
				missing.push(soMatch[1]);
			}
		}
		return missing;
	}

	/**
	 * Reads /etc/os-release and returns the package manager + .so→package map
	 * for the detected distro. Returns null if the distro isn't recognized
	 * (caller falls back to a generic "see docs" warning).
	 *
	 * Distro families:
	 *   apt    → Debian, Ubuntu, Mint, Pop!_OS, Kali, Raspbian
	 *   dnf    → Fedora, RHEL, CentOS, Rocky, AlmaLinux, Oracle Linux
	 *   pacman → Arch, Manjaro, EndeavourOS
	 *   zypper → openSUSE Leap/Tumbleweed, SLES
	 */
	private detectLinuxDistro(): LinuxDistroInfo | null {
		let osRelease: string;
		try {
			osRelease = fs.readFileSync('/etc/os-release', 'utf8');
		} catch {
			return null;
		}

		// Extract ID and ID_LIKE (e.g. ID=ubuntu / ID_LIKE="debian gnu/linux")
		const ids: string[] = [];
		for (const line of osRelease.split('\n')) {
			const m = line.match(/^(ID|ID_LIKE)="?([^"\n]+)"?/);
			if (!m) continue;
			for (const token of m[2].split(/\s+/)) {
				if (token && !ids.includes(token.toLowerCase())) {
					ids.push(token.toLowerCase());
				}
			}
		}

		const has = (...needles: string[]) => needles.some(n => ids.includes(n));

		if (has('debian', 'ubuntu', 'raspbian', 'mint', 'pop', 'kali')) {
			return {
				family: 'apt',
				prettyName: 'Debian/Ubuntu',
				installPrefix: 'sudo apt install -y',
				pkexecArgs: ['apt', 'install', '-y'],
				libToPackage: {
					'libc++.so.1': 'libc++1',
					'libc++abi.so.1': 'libc++abi1',
					'libgomp.so.1': 'libgomp1',
				},
			};
		}

		if (has('fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol')) {
			return {
				family: 'dnf',
				prettyName: 'Fedora/RHEL',
				installPrefix: 'sudo dnf install -y',
				pkexecArgs: ['dnf', 'install', '-y'],
				libToPackage: {
					'libc++.so.1': 'libcxx',
					'libc++abi.so.1': 'libcxxabi',
					'libgomp.so.1': 'libgomp',
				},
			};
		}

		if (has('arch', 'manjaro', 'endeavouros')) {
			return {
				family: 'pacman',
				prettyName: 'Arch',
				installPrefix: 'sudo pacman -S --needed --noconfirm',
				pkexecArgs: ['pacman', '-S', '--needed', '--noconfirm'],
				libToPackage: {
					'libc++.so.1': 'libc++',
					'libc++abi.so.1': 'libc++abi',
					// libgomp on Arch ships inside gcc-libs (part of base, shouldn't be missing,
					// but include for completeness — pacman is happy to reinstall).
					'libgomp.so.1': 'gcc-libs',
				},
			};
		}

		if (has('opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'sles', 'suse')) {
			return {
				family: 'zypper',
				prettyName: 'openSUSE',
				installPrefix: 'sudo zypper install -y',
				pkexecArgs: ['zypper', 'install', '-y'],
				libToPackage: {
					'libc++.so.1': 'libc++1',
					'libc++abi.so.1': 'libc++abi1',
					'libgomp.so.1': 'libgomp1',
				},
			};
		}

		return null;
	}

	/**
	 * Heuristic check for whether the current user can run `sudo`. We try
	 * `sudo -n -v` (non-interactive credential validation) and inspect the
	 * stderr. Three outcomes:
	 *   - exit 0: cached creds or NOPASSWD — sudo will work without prompting
	 *   - stderr says "may not run" / "not in the sudoers" → no access
	 *   - stderr asks for password → access exists, password needed
	 *
	 * We deliberately don't try to detect the cached/NOPASSWD case separately;
	 * for the button decision we only care about "has access" vs "doesn't".
	 */
	private hasSudoAccess(): 'available' | 'missing-binary' | 'no-access' {
		// sudo binary itself missing (rare — minimal containers, embedded systems)
		try {
			execFileSync('sh', ['-c', 'command -v sudo'], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch {
			return 'missing-binary';
		}

		try {
			execFileSync('sudo', ['-n', '-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
			return 'available'; // cached creds or NOPASSWD
		} catch (err) {
			// sudo -n -v exited non-zero. The stderr tells us why.
			const stderr = (err as { stderr?: Buffer | string }).stderr;
			const text = typeof stderr === 'string' ? stderr : stderr?.toString('utf8') ?? '';
			// "a password is required" or "sudo: a terminal is required" → user
			// HAS access but sudo couldn't prompt (which is fine — the terminal
			// in VSCode will prompt interactively when they run the command).
			if (/password is required|terminal is required/i.test(text)) {
				return 'available';
			}
			// "user X is not in the sudoers file" / "X may not run sudo" → no access.
			if (/not in the sudoers|may not run/i.test(text)) {
				return 'no-access';
			}
			// Unknown failure mode — assume available and let the user find out;
			// false positives here are less annoying than false negatives.
			return 'available';
		}
	}

	/** Returns true if `/usr/bin/pkexec` exists and is executable. */
	private hasPkexec(): boolean {
		try {
			fs.accessSync('/usr/bin/pkexec', fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Shows a warning when libs are missing but the distro is unrecognized.
	 * The user gets the raw lib names plus a link to the docs page that lists
	 * commands for every supported distro family.
	 */
	private async showUnknownDistroWarning(missingLibs: string[]): Promise<void> {
		const choice = await vscode.window.showWarningMessage(
			`The RocketRide engine has missing shared libraries: ${missingLibs.join(', ')}. See the docs for distro-specific install commands.`,
			{ modal: true },
			'Learn More'
		);
		if (choice === 'Learn More') {
			void vscode.env.openExternal(
				vscode.Uri.parse('https://github.com/rocketride-org/rocketride-server/blob/develop/docs/setup/LINUX_RUNTIME.md')
			);
		}
	}

	/**
	 * Shows the distro-specific install warning. UX intentionally minimal:
	 * one primary action ("Install Dependencies") that picks the right
	 * elevation mechanism internally — pkexec when available for a native
	 * GUI password popup, terminal fallback otherwise. Plus "Learn More"
	 * for the detailed docs. The modal is blocking so the warning can't
	 * be missed, and the consequence of cancelling is spelled out in
	 * `detail` + a follow-up info notification.
	 */
	private async showLinuxDepsWarning(distro: LinuxDistroInfo, packages: string[]): Promise<void> {
		// Same-arch case: single apt/dnf/pacman install, no sources.list
		// configuration needed. runInstall wraps with sh -c + pkexec (or sudo
		// in a terminal). The shellCmd has no sudo prefix because the elevation
		// is added by runInstall depending on which path it takes.
		const shellCmd = `${distro.pkexecArgs.join(' ')} ${packages.join(' ')}`;
		const terminalCmd = `${distro.installPrefix} ${packages.join(' ')}`;
		const sudoStatus = this.hasSudoAccess();
		const canInstall = sudoStatus === 'available' || sudoStatus === 'missing-binary';

		const baseMsg = `RocketRide needs ${packages.length === 1 ? 'a system library' : 'system libraries'} not yet installed on this ${distro.prettyName} system: ${packages.join(', ')}.`;

		const cancelConsequence = sudoStatus === 'no-access'
			? `Your account does not have sudo access — ask your administrator to run: ${terminalCmd}`
			: `Without these libraries the engine cannot start. If you cancel, run this command later to install them: ${terminalCmd}`;

		const buttons: string[] = [];
		if (canInstall) buttons.push('Install System Dependency');
		buttons.push('Learn More');

		const choice = await vscode.window.showWarningMessage(
			baseMsg,
			{ modal: true, detail: cancelConsequence },
			...buttons,
		);

		if (choice === 'Install System Dependency') {
			await this.runInstall({
				shellCmd,
				terminalCmd,
				purpose: 'system libraries',
			});
		} else if (choice === 'Learn More') {
			void vscode.env.openExternal(
				vscode.Uri.parse('https://github.com/rocketride-org/rocketride-server/blob/develop/docs/setup/LINUX_RUNTIME.md')
			);
		} else if (canInstall) {
			// User dismissed (Cancel / Escape / X). Surface a non-modal info
			// reminder with the manual command so they aren't left wondering
			// what to do when the engine fails to start on the next click.
			void vscode.window.showInformationMessage(
				`RocketRide will fail to start until you install: ${terminalCmd}`,
				'Copy Command',
			).then(c => {
				if (c === 'Copy Command') void vscode.env.clipboard.writeText(terminalCmd);
			});
		}
	}

	/**
	 * Runs an elevated install command. Two paths:
	 *
	 *   • pkexec available → execFile pkexec with sh -c <shellCmd>, wrapped
	 *     in a VS Code progress notification. The desktop environment shows
	 *     its native GUI password dialog (polkitd handles the password — it
	 *     never touches Node); apt runs silently; user gets a success/error
	 *     toast. No terminal visible.
	 *
	 *   • pkexec missing → open integrated terminal with the sudo command
	 *     pre-typed but NOT executed. User reviews, hits Enter, sudo asks
	 *     for the password directly on the TTY.
	 *
	 * Either elevation path keeps the password out of the extension process.
	 *
	 * @param opts.shellCmd - The install invocation without sudo (e.g.
	 *     "apt install -y libc++1 libc++abi1 libgomp1"). pkexec adds root.
	 * @param opts.terminalCmd - Full command for terminal/manual fallback,
	 *     usually shellCmd prefixed with "sudo " (shown in error/cancel toasts).
	 * @param opts.purpose - Human-readable purpose for progress/toast UI
	 *     (e.g. "system libraries").
	 */
	private async runInstall(opts: { shellCmd: string; terminalCmd: string; purpose: string }): Promise<void> {
		const pkexecAvailable = this.hasPkexec();

		if (pkexecAvailable) {
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Installing ${opts.purpose}...`,
						cancellable: false,
					},
					() => new Promise<void>((resolve, reject) => {
						// pkexec runs a single binary as root. Going through
						// `sh -c` lets us pass shellCmd as one quoted argument.
						const child = execFile(
							'pkexec',
							['sh', '-c', opts.shellCmd],
							{ timeout: 5 * 60 * 1000 },
							(err: Error | null, _stdout: string, stderr: string) => {
								if (err) reject(new Error(stderr?.trim() || err.message));
								else resolve();
							},
						);
						// Callback handles completion; nothing else to do with the handle.
						void child;
					}),
				);
				void vscode.window.showInformationMessage(
					`Installed ${opts.purpose}. RocketRide is ready to start.`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// pkexec returns "Not authorized" / "dismissed" when the user
				// cancels the password dialog — a normal user action, not an
				// extension failure. Differentiate from real apt errors.
				if (/dismissed|cancell?ed|Not authorized|Authentication failed/i.test(msg)) {
					void vscode.window.showWarningMessage(
						`Installation cancelled. RocketRide will fail to start until you install: ${opts.terminalCmd}`,
					);
				} else {
					void vscode.window.showErrorMessage(
						`Failed to install ${opts.purpose}: ${msg}. Try running manually: ${opts.terminalCmd}`,
					);
				}
			}
		} else {
			// Fallback: open terminal with the sudo command pre-typed (NOT
			// executed). The user reviews, edits if needed, and presses Enter.
			// sudo's password prompt comes from the TTY directly.
			const terminal = vscode.window.createTerminal({
				name: `RocketRide: install ${opts.purpose}`,
			});
			terminal.show();
			terminal.sendText(opts.terminalCmd, false);
			void vscode.window.showInformationMessage(
				'A terminal was opened with the install command. Review and press Enter to run it.',
			);
		}
	}
}

// =============================================================================
// LINUX DISTRO TYPES (used by EngineInstaller above)
// =============================================================================

/**
 * Distro family info for building install commands. One of these is returned
 * by detectLinuxDistro() per supported family.
 */
interface LinuxDistroInfo {
	/** Package manager family. */
	family: 'apt' | 'dnf' | 'pacman' | 'zypper';
	/** Short human-readable name for messages (e.g. "Debian/Ubuntu"). */
	prettyName: string;
	/** Full shell prefix including sudo (e.g. "sudo apt install -y"). */
	installPrefix: string;
	/** Argv (without "pkexec" or "sudo") for the pkexec-prefixed variant. */
	pkexecArgs: string[];
	/** Map .so name → package name in this distro's repos. */
	libToPackage: Record<string, string>;
}

// =============================================================================
// UTILITY
// =============================================================================

/**
 * Checks if a process with the given PID is currently running.
 * Uses signal 0 which doesn't actually send a signal — just checks existence.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
