import {
    ConfigurationTarget,
    ExtensionContext,
    ProgressLocation,
    Uri,
    window,
    workspace,
} from 'vscode';
import { createWriteStream, existsSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request as httpsRequest } from 'https';
import { request as httpRequest, IncomingMessage } from 'http';
import { URL } from 'url';
import AdmZip = require('adm-zip');

const RUNTIME_URL =
    'https://github.com/isacfg/fluig-process-runtime/releases/download/fluig-process-v1/fluig-process-runtime.zip';

export class FluigProcessRuntimeInstaller {
    public static runtimeDir(context: ExtensionContext): string {
        return join(context.globalStorageUri.fsPath, 'fluig-process');
    }

    public static async install(context: ExtensionContext): Promise<string | undefined> {
        const url = RUNTIME_URL;
        const targetDir = FluigProcessRuntimeInstaller.runtimeDir(context);

        try {
            return await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: 'Instalando runtime fluig-process',
                    cancellable: false,
                },
                async progress => {
                    progress.report({ message: 'Baixando ZIP...' });

                    const zipPath = join(
                        tmpdir(),
                        `fluig-process-runtime-${Date.now()}.zip`
                    );
                    await FluigProcessRuntimeInstaller.download(url, zipPath, progress);

                    progress.report({ message: 'Extraindo...' });
                    await fsp.mkdir(targetDir, { recursive: true });
                    await FluigProcessRuntimeInstaller.cleanDir(targetDir);

                    await new Promise<void>((resolveExtract, rejectExtract) => {
                        setImmediate(() => {
                            try {
                                const zip = new AdmZip(zipPath);
                                zip.extractAllTo(targetDir, true);
                                resolveExtract();
                            } catch (err) {
                                rejectExtract(err);
                            }
                        });
                    });
                    await fsp.unlink(zipPath).catch(() => undefined);

                    progress.report({ message: 'Validando...' });
                    const resolvedHome = await FluigProcessRuntimeInstaller.resolveHomeAfterExtract(
                        targetDir
                    );

                    if (!resolvedHome) {
                        throw new Error(
                            'ZIP extraído não contém plugins/org.eclipse.equinox.launcher_*.jar'
                        );
                    }

                    await workspace
                        .getConfiguration('fluiggers')
                        .update(
                            'fluigProcessHome',
                            resolvedHome,
                            ConfigurationTarget.Global
                        );

                    window.showInformationMessage(
                        `Runtime fluig-process instalado em ${resolvedHome}`
                    );

                    return resolvedHome;
                }
            );
        } catch (error: any) {
            window.showErrorMessage(
                `Falha ao instalar runtime fluig-process: ${error.message || error}`
            );
            return undefined;
        }
    }

    public static async uninstall(context: ExtensionContext): Promise<void> {
        const targetDir = FluigProcessRuntimeInstaller.runtimeDir(context);

        try {
            if (existsSync(targetDir)) {
                await fsp.rm(targetDir, { recursive: true, force: true });
            }

            await workspace
                .getConfiguration('fluiggers')
                .update('fluigProcessHome', '', ConfigurationTarget.Global);

            window.showInformationMessage('Runtime fluig-process removido.');
        } catch (error: any) {
            window.showErrorMessage(
                `Falha ao remover runtime fluig-process: ${error.message || error}`
            );
        }
    }

    private static async cleanDir(dir: string): Promise<void> {
        const entries = await fsp.readdir(dir).catch(() => []);
        await Promise.all(
            entries.map(name =>
                fsp
                    .rm(join(dir, name), { recursive: true, force: true })
                    .catch(err => {
                        console.warn(
                            `[fluig-process] falha ao limpar ${join(dir, name)}: ${err.message || err}`
                        );
                    })
            )
        );
    }

    private static async resolveHomeAfterExtract(targetDir: string): Promise<string | null> {
        if (await FluigProcessRuntimeInstaller.hasLauncher(targetDir)) {
            return targetDir;
        }

        const entries = await fsp.readdir(targetDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const candidate = join(targetDir, entry.name);
            if (await FluigProcessRuntimeInstaller.hasLauncher(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private static async hasLauncher(dir: string): Promise<boolean> {
        const plugins = join(dir, 'plugins');
        const runtimePlugins = join(dir, 'runtime', 'plugins');
        const candidates = [plugins, runtimePlugins];

        for (const folder of candidates) {
            try {
                const files = await fsp.readdir(folder);
                if (files.some(name => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name))) {
                    return true;
                }
            } catch {
                // ignore missing folder
            }
        }
        return false;
    }

    private static download(
        url: string,
        destination: string,
        progress: { report: (value: { message?: string; increment?: number }) => void }
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const fail = (err: Error) => {
                fsp.unlink(destination).catch(() => undefined);
                reject(err);
            };

            const followRedirect = (currentUrl: string, redirects: number) => {
                if (redirects > 8) {
                    fail(new Error('Excesso de redirecionamentos ao baixar runtime.'));
                    return;
                }

                const parsed = new URL(currentUrl);
                const requester = parsed.protocol === 'http:' ? httpRequest : httpsRequest;

                const req = requester(
                    {
                        method: 'GET',
                        protocol: parsed.protocol,
                        hostname: parsed.hostname,
                        port: parsed.port,
                        path: parsed.pathname + parsed.search,
                        headers: { 'User-Agent': 'fluig-vscode-extension' },
                    },
                    (res: IncomingMessage) => {
                        if (
                            res.statusCode &&
                            res.statusCode >= 300 &&
                            res.statusCode < 400 &&
                            res.headers.location
                        ) {
                            res.resume();
                            const next = new URL(res.headers.location, currentUrl).toString();
                            followRedirect(next, redirects + 1);
                            return;
                        }

                        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                            fail(
                                new Error(
                                    `HTTP ${res.statusCode} ao baixar ${currentUrl}`
                                )
                            );
                            res.resume();
                            return;
                        }

                        const total = Number(res.headers['content-length'] || 0);
                        let received = 0;
                        const file = createWriteStream(destination);

                        res.on('data', chunk => {
                            received += chunk.length;
                            if (total > 0) {
                                const pct = ((received / total) * 100).toFixed(0);
                                progress.report({
                                    message: `Baixando ZIP... ${pct}%`,
                                });
                            }
                        });
                        res.pipe(file);

                        file.on('finish', () => file.close(() => resolve()));
                        file.on('error', fail);
                        res.on('error', fail);
                    }
                );

                req.on('error', fail);
                req.end();
            };

            followRedirect(url, 0);
        });
    }
}
