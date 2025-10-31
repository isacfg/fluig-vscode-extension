// calling workflowEngineService.getAllProcessAvailableToExport("52024121-dcaa-404e-941c-b97314fbec33", "", "1");  (142 ms)
// calling workflowEngineService.exportProcess("52024121-dcaa-404e-941c-b97314fbec33", "", "1", "mapa_cotacao");  (296 ms)

import { ServerDTO } from "../models/ServerDTO";
import { UtilsService } from "./UtilsService";
import { ProcessDTO } from "../models/ProcessDTO";
import { createClientAsync } from "soap";
import { ServerService } from "./ServerService";
import { window, workspace, Uri, ProgressLocation } from "vscode";

export class ProcessService {
    private static getUri(server: ServerDTO): string {
        return (
            UtilsService.getHost(server) +
            "/webdesk/ECMWorkflowEngineService?wsdl"
        );
    }

    /**
     * Retorna uma lista com todos os processos disponíveis
     */
    public static async getProcesses(server: ServerDTO): Promise<ProcessDTO[]> {
        const params = {
            companyId: server.companyId,
            username: server.username,
            password: server.password,
            colleagueId: server.userCode,
        };

        const client = await createClientAsync(ProcessService.getUri(server));
        const response = await client.getAllProcessAvailableToExportAsync(
            params
        );
        // return response[0]?.result?.item || [];

        console.log("######### GET PROCESSSES #########");
        console.log(response);
        return response[0]?.result?.item || [];
    }

    /**
     * Retorna o processo selecionado
     */
    public static async getOptionSelected(
        server: ServerDTO
    ): Promise<ProcessDTO | undefined> {
        const processes = await ProcessService.getProcesses(server);
        const items = processes.map((process) => ({
            label:
                process.processId +
                " - " +
                (process.processName ||
                    process.processDescription ||
                    "Sem nome"),
            detail:
                process.processDescription ||
                `Versão: ${process.processVersion || "N/A"}`,
        }));

        const result = await window.showQuickPick(items, {
            placeHolder: "Selecione o processo",
        });

        if (!result) {
            return undefined;
        }

        const endPosition = result.label.indexOf(" - ");
        const processId = result.label.substring(0, endPosition);
        return processes.find((process) => process.processId === processId);
    }

    /**
     * Exporta um processo específico retornando o XML
     */
    private static async exportProcess(
        server: ServerDTO,
        processId: string
    ): Promise<string> {
        const params = {
            username: server.username,
            password: server.password,
            companyId: server.companyId,
            processId: processId,
        };

        const client = await createClientAsync(ProcessService.getUri(server));
        const response = await client.exportProcessAsync(params);

        // O XML está em response[0].result como string
        const xmlString = response[0]?.result;

        if (!xmlString || typeof xmlString !== "string") {
            throw new Error(
                "Não foi possível extrair o XML da resposta do servidor."
            );
        }

        return xmlString;
    }

    /**
     * Cria um diretório ignorando erros se já existir
     */
    private static async createDirectoryIfNotExists(uri: Uri): Promise<void> {
        try {
            await workspace.fs.createDirectory(uri);
        } catch {
            // Pasta já existe, ignorar
        }
    }

    /**
     * Realiza a importação de um processo específico
     */

    // TODO: Terminar de implementar lógica de import correta, o XML gerado contem mais coisa do que apenas o XML do processo, como as serviceTasks
    public static async import() {
        const server = await ServerService.getSelect();
        if (!server) {
            return;
        }

        const selectedProcess = await ProcessService.getOptionSelected(server);
        if (!selectedProcess) {
            return;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: "Importando Processo",
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({
                        increment: 0,
                        message: "Exportando processo do servidor...",
                    });

                    const processXml = await ProcessService.exportProcess(
                        server,
                        selectedProcess.processId
                    );

                    console.log(
                        "Processo exportado. Tamanho:",
                        processXml.length
                    );

                    progress.report({
                        increment: 50,
                        message: "Salvando arquivos...",
                    });

                    const processId = selectedProcess.processId;

                    // Cria a estrutura de pastas
                    await ProcessService.createDirectoryIfNotExists(
                        Uri.joinPath(UtilsService.getWorkspaceUri(), "workflow")
                    );
                    await ProcessService.createDirectoryIfNotExists(
                        Uri.joinPath(
                            UtilsService.getWorkspaceUri(),
                            "workflow",
                            "diagrams"
                        )
                    );

                    // Salva o XML do processo diretamente em workflow/diagrams/
                    const processXmlUri = Uri.joinPath(
                        UtilsService.getWorkspaceUri(),
                        "workflow",
                        "diagrams",
                        `${processId}.process`
                    );
                    await workspace.fs.writeFile(
                        processXmlUri,
                        Buffer.from(processXml, "utf-8")
                    );

                    progress.report({ increment: 100, message: "Concluído!" });

                    console.log(
                        "Processo importado com sucesso em:",
                        processXmlUri.fsPath
                    );

                    window.showInformationMessage(
                        `Processo ${processId} importado com sucesso!`
                    );
                }
            );
        } catch (error) {
            console.error("Erro ao importar processo:", error);
            window.showErrorMessage(
                `Erro ao importar processo: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
}
