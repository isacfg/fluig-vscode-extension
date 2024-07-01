import * as vscode from "vscode";
import * as fs from "fs";
import { ServerService } from "../services/ServerService";
const compile = require("template-literal");

export class FastExportConfigView {
    private currentPanel: vscode.WebviewPanel | undefined = undefined;

    constructor(private context: vscode.ExtensionContext) {}

    public show() {
        this.currentPanel = this.createWebViewPanel();
        this.currentPanel.webview.html = this.getWebViewContent();
        this.currentPanel.onDidDispose(
            () => (this.currentPanel = undefined),
            null
        );
        this.currentPanel.webview.onDidReceiveMessage(
            (obj) => this.messageListener(obj),
            undefined
        );
    }

    private getWebViewContent() {
        const htmlPath = vscode.Uri.joinPath(
            this.context.extensionUri,
            "dist",
            "views",
            "fastExportConfig",
            "fastExportConfig.html"
        );
        const runTemplate = compile(
            fs.readFileSync(htmlPath.with({ scheme: "vscode-resource" }).fsPath)
        );

        const config = vscode.workspace.getConfiguration(
            "fluiggers-fluig-vscode-extension"
        );
        const defaultServerId =
            config.get<string>("fastExport.defaultServerId") || "";
        const defaultParentId =
            config.get<string>("fastExport.defaultParentId") || "";
        const defaultDatasetName =
            config.get<string>("fastExport.defaultDatasetName") || "";
        const defaultPersistenceType = config.get<number>(
            "fastExport.defaultPersistenceType"
        );
        const defaultDescriptionField =
            config.get<string>("fastExport.defaultDescriptionField") || "";

        const servers = ServerService.getServerConfig().configurations;
        const serverOptions = servers
            .map(
                (server) =>
                    `<option value="${server.id}" ${
                        server.id === defaultServerId ? "selected" : ""
                    }>${server.name}</option>`
            )
            .join("");

        return runTemplate({
            jquery: this.currentPanel?.webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this.context.extensionUri,
                    "dist",
                    "libs",
                    "jquery.min.js"
                )
            ),
            bootstrapCss: this.currentPanel?.webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this.context.extensionUri,
                    "dist",
                    "libs",
                    "bootstrap.min.css"
                )
            ),
            themeCss: this.currentPanel?.webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this.context.extensionUri,
                    "dist",
                    "css",
                    "theme.css"
                )
            ),
            fastExportConfigJs: this.currentPanel?.webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this.context.extensionUri,
                    "dist",
                    "views",
                    "fastExportConfig",
                    "fastExportConfig.js"
                )
            ),
            defaultParentId: defaultParentId,
            defaultDatasetName: defaultDatasetName,
            defaultDescriptionField: defaultDescriptionField,
            defaultPersistenceType: defaultPersistenceType === 0 ? "0" : "1",
            serverOptions: serverOptions,
        });
    }

    private createWebViewPanel() {
        return vscode.window.createWebviewPanel(
            "fluig-vscode-extension.fastExportConfig",
            "Fluig: Configurações de Exportação Rápida",
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [this.context.extensionUri],
                retainContextWhenHidden: true,
            }
        );
    }

    private messageListener(message: any) {
        if (message.command === "save") {
            const config = vscode.workspace.getConfiguration(
                "fluiggers-fluig-vscode-extension"
            );

            config.update(
                "fastExport.defaultServerId",
                message.serverId,
                vscode.ConfigurationTarget.Global
            );
            config.update(
                "fastExport.defaultParentId",
                message.parentId,
                vscode.ConfigurationTarget.Global
            );
            config.update(
                "fastExport.defaultDatasetName",
                message.datasetName,
                vscode.ConfigurationTarget.Global
            );
            config.update(
                "fastExport.defaultPersistenceType",
                parseInt(message.persistenceType),
                vscode.ConfigurationTarget.Global
            );
            config.update(
                "fastExport.defaultDescriptionField",
                message.descriptionField,
                vscode.ConfigurationTarget.Global
            );

            vscode.window.showInformationMessage(
                "Configurações salvas com sucesso!"
            );

            if (this.currentPanel) {
                this.currentPanel.dispose();
            }
        }
    }
}
