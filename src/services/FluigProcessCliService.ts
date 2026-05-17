import {
    commands,
    ExtensionContext,
    Uri,
    window,
    workspace,
} from 'vscode';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { spawn, execFile } from 'child_process';
import AdmZip = require('adm-zip');
import { ServerDTO } from '../models/ServerDTO';
import { ProcessDefinitionDTO } from '../models/ProcessDefinitionDTO';
import { UtilsService } from './UtilsService';
import { FluigProcessRuntimeInstaller } from './FluigProcessRuntimeInstaller';

interface CliResultJson {
    status?: string;
    operation?: string;
    processId?: string;
    processFile?: string;
    message?: string;
    exitCode?: number | string;
    processes?: Array<{ processId: string; processDescription: string; active?: boolean }>;
    warnings?: string[];
    validationProblems?: string[];
}

export class FluigProcessCliService {
    private static context: ExtensionContext;
    private static javaAvailable: boolean | undefined;

    public static initialize(context: ExtensionContext): void {
        FluigProcessCliService.context = context;
    }

    public static locateRuntime(): string | null {
        const candidates = [
            workspace
                .getConfiguration('fluiggers')
                .get<string>('fluigProcessHome', '')
                .trim(),
            (process.env.FLUIG_PROCESS_HOME || '').trim(),
            FluigProcessRuntimeInstaller.runtimeDir(FluigProcessCliService.context),
        ];

        for (const candidate of candidates) {
            if (!candidate) {
                continue;
            }
            const resolved = FluigProcessCliService.resolveRuntimeDir(candidate);
            if (resolved) {
                return resolved;
            }
        }

        return null;
    }

    private static resolveRuntimeDir(dir: string): string | null {
        if (!dir || !existsSync(dir)) {
            return null;
        }

        if (FluigProcessCliService.hasLauncherIn(join(dir, 'plugins'))) {
            return dir;
        }

        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const candidate = join(dir, entry.name);
                if (FluigProcessCliService.hasLauncherIn(join(candidate, 'plugins'))) {
                    return candidate;
                }
            }
        } catch {
            // ignore unreadable dirs
        }

        return null;
    }

    private static ensureSwtBundles(runtime: string): void {
        const pluginsDir = join(runtime, 'plugins');
        if (!existsSync(pluginsDir)) {
            return;
        }

        const existing = readdirSync(pluginsDir);
        const fragmentName = FluigProcessCliService.swtFragmentName();

        const hasBase = existing.some(name =>
            /^org\.eclipse\.swt_.*\.jar$/.test(name)
        );
        const hasFragment = fragmentName
            ? existing.some(name =>
                  new RegExp(
                      `^org\\.eclipse\\.swt\\.${fragmentName}_.*\\.jar$`
                  ).test(name)
              )
            : true;

        if (!hasBase || !hasFragment) {
            const eclipsePath = workspace
                .getConfiguration('fluiggers')
                .get<string>('eclipseInstallationPath', '')
                .trim();

            if (!eclipsePath) {
                console.warn(
                    '[fluig-process] runtime sem fragments SWT — configure fluiggers.eclipseInstallationPath para apontar a um Eclipse local, ou regere o pacote fluig-process com os fragments incluídos.'
                );
            } else {
                const eclipsePlugins =
                    FluigProcessCliService.findEclipsePluginsDir(eclipsePath);

                if (!eclipsePlugins) {
                    console.warn(
                        `[fluig-process] não encontrei pasta plugins/ em ${eclipsePath} — fluiggers.eclipseInstallationPath inválido?`
                    );
                } else {
                    const sourceFiles = readdirSync(eclipsePlugins);

                    const copiedBase = FluigProcessCliService.copyMatching(
                        sourceFiles,
                        /^org\.eclipse\.swt_.*\.jar$/,
                        eclipsePlugins,
                        pluginsDir,
                        hasBase
                    );

                    let copiedFragment = false;
                    if (fragmentName) {
                        copiedFragment = FluigProcessCliService.copyMatching(
                            sourceFiles,
                            new RegExp(
                                `^org\\.eclipse\\.swt\\.${fragmentName}_.*\\.jar$`
                            ),
                            eclipsePlugins,
                            pluginsDir,
                            hasFragment
                        );
                    }

                    if (copiedBase || copiedFragment) {
                        FluigProcessCliService.invalidateOsgiCache(runtime);
                    }
                }
            }
        }

        FluigProcessCliService.extractSwtNatives(runtime, fragmentName);
    }

    private static extractSwtNatives(
        runtime: string,
        fragmentName: string | null
    ): void {
        if (!fragmentName) {
            return;
        }

        const pluginsDir = join(runtime, 'plugins');
        const nativesDir = join(runtime, 'swt-natives');

        if (existsSync(nativesDir) && readdirSync(nativesDir).length > 0) {
            return;
        }

        const fragmentRegex = new RegExp(
            `^org\\.eclipse\\.swt\\.${fragmentName}_.*\\.jar$`
        );
        const fragmentJar = readdirSync(pluginsDir).find(name =>
            fragmentRegex.test(name)
        );

        if (!fragmentJar) {
            return;
        }

        try {
            mkdirSync(nativesDir, { recursive: true });
            const zip = new AdmZip(join(pluginsDir, fragmentJar));
            let extracted = 0;
            for (const entry of zip.getEntries()) {
                if (entry.isDirectory) {
                    continue;
                }
                const name = entry.entryName;
                if (
                    name.endsWith('.jnilib') ||
                    name.endsWith('.dylib') ||
                    name.endsWith('.so') ||
                    name.endsWith('.dll')
                ) {
                    const base = name.includes('/')
                        ? name.substring(name.lastIndexOf('/') + 1)
                        : name;
                    writeFileSync(join(nativesDir, base), entry.getData());
                    extracted++;
                }
            }
            if (extracted > 0) {
                console.log(
                    `[fluig-process] extraídas ${extracted} native libs do ${fragmentJar} para ${nativesDir}`
                );
            }
        } catch (error: any) {
            console.warn(
                `[fluig-process] falha extraindo natives SWT: ${error.message || error}`
            );
        }
    }

    private static invalidateOsgiCache(runtime: string): void {
        const cacheDir = join(runtime, 'configuration', 'org.eclipse.osgi');
        if (!existsSync(cacheDir)) {
            return;
        }
        try {
            rmSync(cacheDir, { recursive: true, force: true });
            console.log(`[fluig-process] cache OSGi invalidado em ${cacheDir}`);
        } catch (error: any) {
            console.warn(
                `[fluig-process] falha ao invalidar cache OSGi: ${error.message || error}`
            );
        }
    }

    private static copyMatching(
        names: string[],
        pattern: RegExp,
        from: string,
        to: string,
        alreadyPresent: boolean
    ): boolean {
        if (alreadyPresent) {
            return false;
        }
        const match = names.find(name => pattern.test(name));
        if (!match) {
            console.warn(
                `[fluig-process] bundle ${pattern} não encontrado em ${from}`
            );
            return false;
        }
        const dest = join(to, match);
        if (existsSync(dest)) {
            return false;
        }
        try {
            copyFileSync(join(from, match), dest);
            console.log(`[fluig-process] copiado ${match} para ${to}`);
            return true;
        } catch (error: any) {
            console.warn(
                `[fluig-process] falha ao copiar ${match}: ${error.message || error}`
            );
            return false;
        }
    }

    private static findEclipsePluginsDir(eclipseRoot: string): string | null {
        const candidates = [
            join(eclipseRoot, 'plugins'),
            join(eclipseRoot, 'Contents', 'Eclipse', 'plugins'),
        ];
        return candidates.find(p => existsSync(p)) ?? null;
    }

    private static swtFragmentName(): string | null {
        switch (process.platform) {
            case 'darwin':
                return process.arch === 'arm64'
                    ? 'cocoa\\.macosx\\.aarch64'
                    : 'cocoa\\.macosx\\.x86_64';
            case 'linux':
                return process.arch === 'arm64'
                    ? 'gtk\\.linux\\.aarch64'
                    : 'gtk\\.linux\\.x86_64';
            case 'win32':
                return process.arch === 'arm64'
                    ? 'win32\\.win32\\.aarch64'
                    : 'win32\\.win32\\.x86_64';
            default:
                return null;
        }
    }

    private static hasLauncherIn(pluginsDir: string): boolean {
        try {
            const files = readdirSync(pluginsDir);
            return files.some(name =>
                /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name)
            );
        } catch {
            return false;
        }
    }

    public static locateCliJar(runtime: string | null): string | null {
        const fromSetting = workspace
            .getConfiguration('fluiggers')
            .get<string>('fluigProcessCliPath', '')
            .trim();

        if (fromSetting && existsSync(fromSetting)) {
            return fromSetting;
        }

        if (runtime) {
            const roots = [runtime, join(runtime, '..')];
            const candidateDirs = ['cli', 'lib'];
            for (const root of roots) {
                for (const sub of candidateDirs) {
                    const dir = join(root, sub);
                    if (!existsSync(dir)) {
                        continue;
                    }
                    const jar = readdirSync(dir).find(
                        name =>
                            name.startsWith('fluig-process-cli') &&
                            name.endsWith('.jar')
                    );
                    if (jar) {
                        return join(dir, jar);
                    }
                }
            }
        }

        const inTree = resolve(
            FluigProcessCliService.context.extensionPath,
            'eclipse-research/research/fluig-process-cli/target/fluig-process-cli-0.1.0-SNAPSHOT.jar'
        );
        if (existsSync(inTree)) {
            return inTree;
        }

        return null;
    }

    public static async ensureReady(): Promise<boolean> {
        const runtime = FluigProcessCliService.locateRuntime();
        const jar = FluigProcessCliService.locateCliJar(runtime);
        const javaOk = await FluigProcessCliService.javaWorks();

        console.log('[fluig-process] ensureReady v3 (swt-natives extractor)', {
            runtime,
            jar,
            javaWorks: javaOk,
        });

        if (runtime && jar && javaOk) {
            FluigProcessCliService.ensureSwtBundles(runtime);
            return true;
        }

        const choice = await window.showErrorMessage(
            'Runtime fluig-process não encontrado. Ele é necessário para importar processos como .process Graphiti.',
            { modal: true },
            'Baixar e instalar',
            'Abrir configurações',
            'Ver instruções'
        );

        if (choice === 'Baixar e instalar') {
            const installed = await FluigProcessRuntimeInstaller.install(
                FluigProcessCliService.context
            );
            if (installed && (await FluigProcessCliService.javaWorks())) {
                return true;
            }
            return false;
        }

        if (choice === 'Abrir configurações') {
            await commands.executeCommand(
                'workbench.action.openSettings',
                'fluiggers.fluigProcess'
            );
            return false;
        }

        if (choice === 'Ver instruções') {
            const readme = Uri.joinPath(
                FluigProcessCliService.context.extensionUri,
                'README.md'
            );
            await commands.executeCommand('markdown.showPreview', readme);
            return false;
        }

        return false;
    }

    public static async diagnose(): Promise<void> {
        const runtime = FluigProcessCliService.locateRuntime();
        const jar = FluigProcessCliService.locateCliJar(runtime);
        const javaOk = await FluigProcessCliService.javaWorks();

        const lines = [
            `Java disponível: ${javaOk ? 'sim' : 'não'}`,
            `FLUIG_PROCESS_HOME resolvido: ${runtime ?? '(nenhum)'}`,
            `CLI jar: ${jar ?? '(nenhum)'}`,
        ];

        if (!runtime || !jar || !javaOk) {
            window.showWarningMessage(lines.join(' | '));
            return;
        }

        try {
            const result = await FluigProcessCliService.runRaw(['--help'], {}, jar, runtime);
            window.showInformationMessage(
                `Runtime OK. ${lines.join(' | ')}. CLI responde: ${result.stdout.split('\n')[0]}`
            );
        } catch (error: any) {
            window.showErrorMessage(
                `CLI presente mas falhou ao executar: ${error.message || error}`
            );
        }
    }

    public static async list(server: ServerDTO): Promise<ProcessDefinitionDTO[]> {
        const result = await FluigProcessCliService.runJson(['list'], server);

        return (result.processes || []).map(item => ({
            processId: item.processId,
            processDescription: item.processDescription || '',
            active: Boolean(item.active),
        }));
    }

    public static async import(
        server: ServerDTO,
        processId: string,
        workspaceDir: string,
        outFile: string
    ): Promise<{ processFile: string; warnings: string[] }> {
        const args = [
            'import',
            '--process-id',
            processId,
            '--project',
            'fluig-process',
            '--out',
            outFile,
            '--overwrite',
        ];

        const result = await FluigProcessCliService.runJson(args, server, workspaceDir);

        return {
            processFile: result.processFile || outFile,
            warnings: result.warnings || [],
        };
    }

    private static async runJson(
        args: string[],
        server: ServerDTO,
        workspaceDir?: string
    ): Promise<CliResultJson> {
        const runtime = FluigProcessCliService.locateRuntime();
        const jar = FluigProcessCliService.locateCliJar(runtime);

        if (!runtime || !jar) {
            throw new Error('Runtime fluig-process não configurado.');
        }

        const fullArgs = [
            ...args,
            '--server-url',
            UtilsService.getHost(server),
            '--user',
            server.username,
            '--company-id',
            String(server.companyId),
            '--json',
        ];

        if (workspaceDir) {
            fullArgs.push('--workspace', workspaceDir);
        }

        const env = {
            ...process.env,
            FLUIG_PROCESS_HOME: runtime,
            FLUIG_PASSWORD: server.password,
        };

        console.log('[fluig-process] spawn', {
            jar,
            runtime,
            args: fullArgs,
        });

        const { stdout, stderr, code } = await FluigProcessCliService.runRaw(
            fullArgs,
            env,
            jar,
            runtime
        );

        console.log('[fluig-process] exit', code);
        if (stderr.trim()) {
            console.log('[fluig-process] stderr:\n' + stderr);
        }
        if (stdout.trim()) {
            console.log('[fluig-process] stdout:\n' + stdout);
        }

        if (!stdout.trim()) {
            throw new Error(
                `CLI fluig-process não retornou nada (exit ${code}). stderr:\n${stderr.trim() || '(vazio)'}`
            );
        }

        const parsed = FluigProcessCliService.parseJsonResult(stdout);

        if (parsed.status && parsed.status !== 'ok') {
            const details = [parsed.message, ...(parsed.validationProblems || [])]
                .filter(Boolean)
                .join('\n');
            throw new Error(details || `CLI retornou status ${parsed.status}`);
        }

        if (code !== 0 && !parsed.status) {
            throw new Error(
                `CLI fluig-process saiu com código ${code}. stderr:\n${stderr.trim() || '(vazio)'}`
            );
        }

        return parsed;
    }

    private static parseJsonResult(stdout: string): CliResultJson {
        const trimmed = stdout.trim();
        if (!trimmed) {
            return {};
        }

        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) {
            throw new Error(`Saída da CLI não é JSON:\n${trimmed}`);
        }

        try {
            return JSON.parse(trimmed.substring(start, end + 1));
        } catch (error: any) {
            throw new Error(`Falha ao parsear JSON da CLI: ${error.message}`);
        }
    }

    private static runRaw(
        args: string[],
        env: NodeJS.ProcessEnv,
        jar: string,
        runtime: string
    ): Promise<{ stdout: string; stderr: string; code: number }> {
        return new Promise((resolvePromise, rejectPromise) => {
            const baseToolOptions = (env.JAVA_TOOL_OPTIONS || '').trim();
            const extras: string[] = ['-Dosgi.clean=true'];

            const nativesDir = join(runtime, 'swt-natives');
            if (existsSync(nativesDir)) {
                extras.push(`-Dswt.library.path=${nativesDir}`);
                extras.push(`-Djava.library.path=${nativesDir}`);
            }

            const javaToolOptions = [baseToolOptions, ...extras]
                .filter(Boolean)
                .join(' ');

            const child = spawn('java', ['-jar', jar, ...args], {
                env: {
                    FLUIG_PROCESS_HOME: runtime,
                    ...env,
                    JAVA_TOOL_OPTIONS: javaToolOptions,
                },
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', chunk => (stdout += chunk.toString()));
            child.stderr.on('data', chunk => (stderr += chunk.toString()));

            child.on('error', err => rejectPromise(err));
            child.on('close', code => {
                const exit = code ?? -1;
                if (exit !== 0 && !stdout.trim()) {
                    rejectPromise(
                        new Error(
                            `java -jar fluig-process-cli falhou (exit ${exit}): ${stderr.trim()}`
                        )
                    );
                    return;
                }
                resolvePromise({ stdout, stderr, code: exit });
            });
        });
    }

    private static async javaWorks(): Promise<boolean> {
        if (FluigProcessCliService.javaAvailable !== undefined) {
            return FluigProcessCliService.javaAvailable;
        }
        const result = await new Promise<boolean>(resolvePromise => {
            execFile('java', ['-version'], err => resolvePromise(!err));
        });
        FluigProcessCliService.javaAvailable = result;
        return result;
    }
}
