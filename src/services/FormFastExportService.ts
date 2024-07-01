import * as vscode from "vscode";
import { FormService } from "./FormService";
import { UtilsService } from "./UtilsService";
import { ServerService } from "./ServerService";
import { FormDTO } from "../models/FormDTO";
import { AttachmentDTO } from "../models/AttachmentDTO";
import { CustomizationEventsDTO } from "../models/CustomizationEventsDTO";
import { basename, parse } from "path";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { glob } from "glob";

export class FormFastExportService {
    public static async fastExport(fileUri: vscode.Uri) {
        const config = vscode.workspace.getConfiguration(
            "fluiggers-fluig-vscode-extension"
        );

        const defaultServerId = config.get<string>(
            "fastExport.defaultServerId"
        );
        const defaultParentId = config.get<string>(
            "fastExport.defaultParentId"
        );
        const defaultDatasetName = config.get<string>(
            "fastExport.defaultDatasetName"
        );
        const defaultPersistenceType = config.get<number>(
            "fastExport.defaultPersistenceType"
        );
        const defaultDescriptionField = config.get<string>(
            "fastExport.defaultDescriptionField"
        );

        if (
            !defaultServerId ||
            !defaultParentId ||
            !defaultDatasetName ||
            defaultPersistenceType === undefined
        ) {
            vscode.window.showErrorMessage(
                "Configurações de Exportação Rápida incompletas. Acesse as Configurações da Extensão."
            );
            return;
        }

        const server = ServerService.findById(defaultServerId);

        if (!server) {
            vscode.window.showErrorMessage("Servidor padrão não encontrado.");
            return;
        }

        const formFolderName: string = fileUri.path.replace(
            /.*\/forms\/([^/]+).*/,
            "$1"
        );
        const formName = formFolderName.replace(/^(?:\d+ - )?(\w+)$/, "$1");

        const params: FormDTO = {
            username: server.username,
            password: server.password,
            companyId: server.companyId,
            publisherId: server.userCode,
            documentId: -1, // Irá criar um novo formulário
            documentDescription: formName,
            cardDescription: defaultDescriptionField || "",
            datasetName: defaultDatasetName,
            Attachments: {
                item: [],
            },
            customEvents: {
                item: [],
            },
            persistenceType: defaultPersistenceType,
            parentDocumentId: parseInt(defaultParentId),
        };

        const formFolder = vscode.Uri.joinPath(
            UtilsService.getWorkspaceUri(),
            "forms",
            formFolderName
        ).fsPath;

        for (let attachmentPath of glob.sync(formFolder + "/**/*.*", {
            nodir: true,
            ignore: formFolder + "/events/**/*.*",
        })) {
            const pathParsed = parse(attachmentPath);

            const attachment: AttachmentDTO = {
                fileName: pathParsed.base,
                filecontent: readFileSync(attachmentPath).toString("base64"),
                principal:
                    pathParsed.ext.toLowerCase().includes("htm") &&
                    formName === pathParsed.name,
            };
            params.Attachments.item.push(attachment);
        }

        for (let eventPath of glob.sync(formFolder + "/events/*.js")) {
            const customEvent: CustomizationEventsDTO = {
                eventDescription: readFileSync(eventPath).toString("utf-8"),
                eventId: basename(eventPath, ".js"),
                eventVersAnt: false,
            };
            params.customEvents.item.push(customEvent);
        }

        try {
            const client = await FormService.getClient(server);
            const response: any =
                await client.createSimpleCardIndexWithDatasetPersisteTypeAsync(
                    params
                );
            const message = response[0]?.result?.item?.webServiceMessage;

            if (message === "ok") {
                vscode.window.showInformationMessage(
                    `Formulário ${formName} exportado com sucesso!`
                );
            } else {
                vscode.window.showErrorMessage(
                    message ||
                        "Verifique o id da Pasta onde irá salvar o Formulário!"
                );
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                "Erro ao exportar Formulário: " + err
            );
        }
    }
}
