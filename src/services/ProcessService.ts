import { ProgressLocation, QuickPickItem, Uri, window } from 'vscode';
import { mkdtempSync, promises as fsp, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { glob } from 'glob';
import { ServerDTO } from '../models/ServerDTO';
import { ProcessDefinitionDTO } from '../models/ProcessDefinitionDTO';
import { ServerService } from './ServerService';
import { UtilsService } from './UtilsService';
import { FluigProcessCliService } from './FluigProcessCliService';

type OverwriteChoice = 'overwrite' | 'skip' | 'cancel';

export class ProcessService {
    public static async import(): Promise<void> {
        try {
            const server = await ServerService.getSelect();
            if (!server) {
                return;
            }

            if (!(await FluigProcessCliService.ensureReady())) {
                return;
            }

            const process = await ProcessService.getOptionSelected(server);
            if (!process) {
                return;
            }

            const overwrite = await ProcessService.askOverwrite([process.processId]);
            if (overwrite === 'cancel') {
                return;
            }

            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Importando processo ${process.processId}`,
                    cancellable: false,
                },
                async () => {
                    await ProcessService.runImport(server, process.processId, overwrite);
                }
            );

            const target = ProcessService.targetProcessUri(process.processId);
            if (existsSync(target.fsPath)) {
                window.showTextDocument(target);
                window.showInformationMessage(
                    `Processo ${process.processId} importado.`
                );
            } else {
                window.showWarningMessage(
                    `CLI terminou sem erros, mas ${target.fsPath} não foi criado. Veja Developer Tools > Console.`
                );
            }
        } catch (error: any) {
            console.error('[ProcessService.import] falhou', error);
            window.showErrorMessage(
                `Falha ao importar processo: ${error?.message || error}`
            );
        }
    }

    public static async importMany(): Promise<void> {
        try {
            await ProcessService.importManyInner();
        } catch (error: any) {
            console.error('[ProcessService.importMany] falhou', error);
            window.showErrorMessage(
                `Falha ao importar processos: ${error?.message || error}`
            );
        }
    }

    private static async importManyInner(): Promise<void> {
        const server = await ServerService.getSelect();
        if (!server) {
            return;
        }

        if (!(await FluigProcessCliService.ensureReady())) {
            return;
        }

        const processes = await ProcessService.getOptionsSelected(server);
        if (!processes.length) {
            return;
        }

        const overwrite = await ProcessService.askOverwrite(
            processes.map(p => p.processId)
        );
        if (overwrite === 'cancel') {
            return;
        }

        let imported = 0;
        const failures: Array<{ id: string; error: string }> = [];

        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Importando processos',
                cancellable: false,
            },
            async progress => {
                const increment = 100 / processes.length;
                for (const process of processes) {
                    progress.report({
                        message: process.processId,
                        increment,
                    });
                    try {
                        const result = await ProcessService.runImport(
                            server,
                            process.processId,
                            overwrite
                        );
                        if (result === 'skipped') {
                            continue;
                        }
                        imported++;
                    } catch (error: any) {
                        failures.push({
                            id: process.processId,
                            error: error.message || String(error),
                        });
                    }
                }
            }
        );

        if (failures.length) {
            window.showWarningMessage(
                `${imported} processos importados. ${failures.length} falharam:\n` +
                    failures.map(f => `- ${f.id}: ${f.error}`).join('\n')
            );
        } else {
            window.showInformationMessage(`${imported} processos importados.`);
        }
    }

    private static async runImport(
        server: ServerDTO,
        processId: string,
        overwriteChoice: OverwriteChoice
    ): Promise<'imported' | 'skipped'> {
        const targetProcess = ProcessService.targetProcessUri(processId);

        if (existsSync(targetProcess.fsPath)) {
            if (overwriteChoice === 'skip') {
                return 'skipped';
            }
        }

        const tmpWorkspace = mkdtempSync(join(tmpdir(), 'fluig-vscode-import-'));
        const safeId = processId.replace(/\//g, '_');
        const cliOut = join(tmpWorkspace, 'out', `${safeId}.process`);
        let imported = false;

        try {
            await fsp.mkdir(dirname(cliOut), { recursive: true });

            try {
                await FluigProcessCliService.import(
                    server,
                    processId,
                    tmpWorkspace,
                    cliOut
                );
            } catch (error: any) {
                const logs = await ProcessService.collectEclipseLogs(tmpWorkspace);
                if (logs) {
                    console.error(
                        '[ProcessService.runImport] Eclipse logs:\n' + logs
                    );
                    error.message =
                        (error.message || String(error)) +
                        '\n\nLogs do Eclipse (resumido — completo no Developer Console):\n' +
                        ProcessService.headAndTail(logs, 2500, 1500);
                }
                throw error;
            }

            const projectRoot = join(tmpWorkspace, 'fluig-process');
            await ProcessService.copyArtifacts(safeId, projectRoot, cliOut);
            imported = true;

            return 'imported';
        } finally {
            if (imported) {
                await fsp.rm(tmpWorkspace, { recursive: true, force: true }).catch(
                    () => undefined
                );
            } else {
                console.log(
                    `[ProcessService] workspace preservado para inspeção: ${tmpWorkspace}`
                );
            }
        }
    }

    private static async collectEclipseLogs(tmpWorkspace: string): Promise<string> {
        const sources: string[] = [
            join(tmpWorkspace, '.metadata', '.log'),
        ];

        const parts: string[] = [];

        for (const path of sources) {
            try {
                if (existsSync(path)) {
                    const content = await fsp.readFile(path, 'utf8');
                    if (content.trim()) {
                        parts.push(`--- ${path} ---\n${content}`);
                    }
                }
            } catch {
                // ignore
            }
        }

        return parts.join('\n\n');
    }

    private static headAndTail(text: string, headMax: number, tailMax: number): string {
        if (text.length <= headMax + tailMax) {
            return text;
        }
        return (
            text.slice(0, headMax) +
            '\n\n... (omitido o meio do log) ...\n\n' +
            text.slice(-tailMax)
        );
    }

    private static async copyArtifacts(
        safeId: string,
        projectRoot: string,
        cliOut: string
    ): Promise<void> {
        const wsRoot = UtilsService.getWorkspaceUri().fsPath;

        const diagramsDir = join(wsRoot, 'workflow', 'diagrams');
        await fsp.mkdir(diagramsDir, { recursive: true });

        const sourceProcess = existsSync(cliOut)
            ? cliOut
            : join(projectRoot, 'workflow', 'diagrams', `${safeId}.process`);

        if (!existsSync(sourceProcess)) {
            throw new Error(
                `Arquivo .process não encontrado após import: ${sourceProcess}`
            );
        }

        await fsp.copyFile(sourceProcess, join(diagramsDir, `${safeId}.process`));

        const scriptsSrc = join(projectRoot, 'workflow', 'scripts');
        if (existsSync(scriptsSrc)) {
            const scriptsDest = join(wsRoot, 'workflow', 'scripts');
            await fsp.mkdir(scriptsDest, { recursive: true });
            const scripts = await glob(`${safeId}.*.js`, { cwd: scriptsSrc });
            await Promise.all(
                scripts.map(name =>
                    fsp.copyFile(join(scriptsSrc, name), join(scriptsDest, name))
                )
            );
        }

        const literalsSrc = join(projectRoot, 'workflow', '.resources', 'literals');
        if (existsSync(literalsSrc)) {
            const literalsDest = join(wsRoot, 'workflow', '.resources', 'literals');
            await fsp.mkdir(literalsDest, { recursive: true });
            const literals = await glob(`${safeId}_*.properties`, { cwd: literalsSrc });
            await Promise.all(
                literals.map(name =>
                    fsp.copyFile(join(literalsSrc, name), join(literalsDest, name))
                )
            );
        }
    }

    private static targetProcessUri(processId: string): Uri {
        const safeId = processId.replace(/\//g, '_');
        return Uri.joinPath(
            UtilsService.getWorkspaceUri(),
            'workflow',
            'diagrams',
            `${safeId}.process`
        );
    }

    private static async askOverwrite(ids: string[]): Promise<OverwriteChoice> {
        const existing = ids.filter(id => existsSync(ProcessService.targetProcessUri(id).fsPath));

        if (!existing.length) {
            return 'overwrite';
        }

        const detail =
            existing.length === 1
                ? `O processo "${existing[0]}" já existe em workflow/diagrams.`
                : `${existing.length} processos já existem em workflow/diagrams:\n- ${existing.join('\n- ')}`;

        const choice = await window.showWarningMessage(
            'Alguns processos já estão importados.',
            { modal: true, detail },
            'Sobrescrever',
            'Pular existentes'
        );

        if (choice === 'Sobrescrever') {
            return 'overwrite';
        }
        if (choice === 'Pular existentes') {
            return 'skip';
        }
        return 'cancel';
    }

    private static async getOptionSelected(
        server: ServerDTO
    ): Promise<ProcessDefinitionDTO | undefined> {
        const processes = await ProcessService.fetchList(server);
        if (!processes.length) {
            return undefined;
        }

        const items: (QuickPickItem & { dto: ProcessDefinitionDTO })[] = processes.map(p => ({
            label: p.processId,
            detail: p.processDescription,
            description: p.active === false ? '(inativo)' : undefined,
            dto: p,
        }));

        const picked = await window.showQuickPick(items, {
            placeHolder: 'Selecione o processo para importar',
            matchOnDetail: true,
        });

        return picked?.dto;
    }

    private static async getOptionsSelected(
        server: ServerDTO
    ): Promise<ProcessDefinitionDTO[]> {
        const processes = await ProcessService.fetchList(server);
        if (!processes.length) {
            return [];
        }

        const items: (QuickPickItem & { dto: ProcessDefinitionDTO })[] = processes.map(p => ({
            label: p.processId,
            detail: p.processDescription,
            description: p.active === false ? '(inativo)' : undefined,
            dto: p,
        }));

        const picked = await window.showQuickPick(items, {
            placeHolder: 'Selecione os processos para importar',
            canPickMany: true,
            matchOnDetail: true,
        });

        return (picked || []).map(item => item.dto);
    }

    private static async fetchList(server: ServerDTO): Promise<ProcessDefinitionDTO[]> {
        return window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Buscando lista de processos no servidor',
                cancellable: false,
            },
            () => FluigProcessCliService.list(server)
        );
    }
}
