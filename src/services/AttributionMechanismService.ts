import * as vscode from 'vscode';
import * as https from 'https';
import axios from 'axios';
import { basename } from "path";
import { UtilsService } from './UtilsService';
import { ServerDTO } from '../models/ServerDTO';
import { AttributionMechanismDTO } from '../models/AttributionMechanismDTO';
import { ServerService } from './ServerService';
import { readFileSync } from 'fs';

const basePath = "/ecm/api/rest/ecm/mechanism/";

export class AttributionMechanismService {
    private static getBasePath(server: ServerDTO, action: string): string {
        const host = UtilsService.getHost(server);
        return `${host}${basePath}${action}?username=${encodeURIComponent(server.username)}&password=${encodeURIComponent(server.password)}`;
    }

    private static async list(server: ServerDTO): Promise<AttributionMechanismDTO[]> {
        const endpoint = AttributionMechanismService.getBasePath(server, "getCustomAttributionMechanismList");

        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        const result = await axios.get(endpoint, {
            httpsAgent: agent
        });

        if (result.status === 200 && !result.data.content) {
            return result.data;
        }

        vscode.window.showErrorMessage(result.data.message.message);

        return [];
    }

    private static async create(server: ServerDTO, mechanism: AttributionMechanismDTO) {
        const endpoint = AttributionMechanismService.getBasePath(server, "createAttributionMechanism");

        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        return await axios.post(endpoint, mechanism, {
            httpsAgent: agent
        });
    }

    private static async update(server: ServerDTO, mechanism: AttributionMechanismDTO) {
        const endpoint = AttributionMechanismService.getBasePath(server, "updateAttributionMechanism");

        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        return await axios.post(endpoint, mechanism, {
            httpsAgent: agent
        });
    }

    private static async delete(server: ServerDTO, mechanismId: string) {
        const endpoint = AttributionMechanismService.getBasePath(server, "deleteAttributionMechanism") + `&mechanismId=${mechanismId}`;

        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        const result = await axios.delete(endpoint, {
            httpsAgent: agent
        });
    }

    /**
     * Retorna o mecanismo selecionado
     */
    public static async getOptionSelected(server: ServerDTO): Promise<AttributionMechanismDTO|null> {
        const mechanisms = await AttributionMechanismService.list(server);
        const items = mechanisms.map(mechanism => ({ label: mechanism.attributionMecanismPK.attributionMecanismId, detail: mechanism.name }));
        const result = await vscode.window.showQuickPick(items, {
            placeHolder: "Selecione o Mecanismo de Atribuição"
        });

        if (!result) {
            return null;
        }

        return mechanisms.find(mechanism => mechanism.attributionMecanismPK.attributionMecanismId === result.label) || null;
    }

    /**
     * Retorna os mecanismos selecionados
     */
    public static async getOptionsSelected(server: ServerDTO): Promise<AttributionMechanismDTO[]> {
        const mechanisms = await AttributionMechanismService.list(server);
        const items = mechanisms.map(mechanism => ({ label: mechanism.attributionMecanismPK.attributionMecanismId, detail: mechanism.name }));
        const result = await vscode.window.showQuickPick(items, {
            placeHolder: "Selecione o Mecanismo de Atribuição",
            canPickMany: true
        });

        if (!result) {
            return [];
        }

        const itemsSelected = result.map(v => v.label);

        return mechanisms.filter(mechanism => itemsSelected.includes(mechanism.attributionMecanismPK.attributionMecanismId));
    }

    /**
     * Realiza a importação de um mecanismo específico
     */
    public static async import() {
        const server = await ServerService.getSelect();

        if (!server) {
            return;
        }

        const mechanism = await AttributionMechanismService.getOptionSelected(server);

        if (!mechanism) {
            return;
        }

        AttributionMechanismService.saveFile(mechanism.attributionMecanismPK.attributionMecanismId, mechanism.attributionMecanismDescription);
    }

    /**
     * Realiza a importação de vários mecanismos de atribuição
     */
    public static async importMany() {
        const server = await ServerService.getSelect();

        if (!server) {
            return;
        }

        const mechanisms = await AttributionMechanismService.getOptionsSelected(server);

        if (!mechanisms.length) {
            return;
        }

        mechanisms.forEach(
            mechanism => AttributionMechanismService.saveFile(mechanism.attributionMecanismPK.attributionMecanismId, mechanism.attributionMecanismDescription)
        );
    }

    /**
     * Cria ou Atualiza Mecanismo de Atribuição no servidor
     */
    public static async export(fileUri: vscode.Uri) {
        const server = await ServerService.getSelect();

        if (!server) {
            return;
        }

        const mechanisms = await AttributionMechanismService.list(server);
        const items = [];

        let mechanismSelected = { label: "", detail: "" };
        let mechanismId: string = basename(fileUri.fsPath, '.js');

        for (let mechanism of mechanisms) {
            if (mechanism.attributionMecanismPK.attributionMecanismId !== mechanismId) {
                items.push({ label: mechanism.attributionMecanismPK.attributionMecanismId, detail: mechanism.name });
            } else {
                mechanismSelected = { label: mechanism.attributionMecanismPK.attributionMecanismId, detail: mechanism.name };
            }
        }

        items.unshift({ label: 'Novo Mecanismo Customizado', detail: "" });

        if (mechanismSelected.label !== '') {
            items.unshift(mechanismSelected);
        }

        mechanismSelected = (await vscode.window.showQuickPick(items, {
            placeHolder: "Criar ou Editar Mecanismo Customizado?"
        })) || { label: "", detail: "" };

        if (!mechanismSelected.label) {
            return;
        }

        const isNew = mechanismSelected.label === 'Novo Mecanismo Customizado';

        let mechanismStructure: AttributionMechanismDTO | undefined = undefined;
        let name: string = '';
        let description: string = '';

        if (isNew) {
            let existMechanism: boolean = false;

            do {
                mechanismId = await vscode.window.showInputBox({
                    prompt: "Qual o código do Mecanismo Customizado (sem espaços e sem caracteres especiais)?",
                    placeHolder: "mecanismo_customizado",
                    value: mechanismId
                }) || "";

                if (!mechanismId) {
                    return;
                }

                existMechanism = mechanisms.find((mechanism => mechanism.attributionMecanismPK.attributionMecanismId === mechanismId)) !== undefined;

                if (existMechanism) {
                    vscode.window.showWarningMessage(`O mecanismo "${mechanismId}" já existe no servidor "${server.name}"!`);
                }
            } while (existMechanism);

            mechanismStructure = {
                attributionMecanismPK: {
                    companyId: server.companyId,
                    attributionMecanismId: mechanismId
                },
                assignmentType: 1,
                controlClass: "com.datasul.technology.webdesk.workflow.assignment.customization.CustomAssignmentImpl",
                preSelectionClass: null,
                configurationClass: "",
                name: "",
                description: "",
                attributionMecanismDescription: ""
            };
        } else {
            mechanismId = mechanismSelected.label;
            mechanismStructure = mechanisms.find(mechanism => mechanism.attributionMecanismPK.attributionMecanismId === mechanismId);
        }

        name = await vscode.window.showInputBox({
            prompt: "Qual o nome do Mecanismo Customizado?",
            placeHolder: "Nome do Mecanismo",
            value: mechanismStructure?.name || mechanismId
        }) || "";

        description = await vscode.window.showInputBox({
            prompt: "Qual a descrição do Mecanismo Customizado?",
            placeHolder: "Descrição do Mecanismo",
            value: mechanismStructure?.description || mechanismId
        }) || "";

        if (!mechanismStructure || !description || !name) {
            return;
        }

        mechanismStructure.name = name;
        mechanismStructure.description = description;
        mechanismStructure.attributionMecanismDescription = readFileSync(fileUri.fsPath, 'utf8');

        let result: any = undefined;

        // Validar senha antes de exportar
        if (server.confirmExporting && !(await UtilsService.confirmPassword(server))) {
            return;
        }

        if (isNew) {
            result = await AttributionMechanismService.create(server, mechanismStructure);
        } else {
            result = await AttributionMechanismService.update(server, mechanismStructure);
        }

        if (result.data.content === 'OK') {
            vscode.window.showInformationMessage("Mecanismo Customizado " + mechanismId + " exportado com sucesso!");
        } else {
            vscode.window.showErrorMessage("Falha ao exportar o Mecanismo Customizado " + mechanismId + "!\n\n" + result.data.message.message);
        }
    }

    /**
     * Cria o arquivo de Mecanismo de Atribuição
     */
    private static async saveFile(name: string, content: string) {
        const fileUri = vscode.Uri.joinPath(UtilsService.getWorkspaceUri(), "mechanisms", name + ".js");

        await vscode.workspace.fs.writeFile(
            fileUri,
            Buffer.from(content, "utf-8")
        );

        vscode.window.showTextDocument(fileUri);
        vscode.window.showInformationMessage("Mecanismo de Atribuição " + name + " importado com sucesso!");
    }
}
