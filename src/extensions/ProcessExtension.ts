import * as vscode from "vscode";
import { ProcessService } from "../services/ProcessService";

export class ProcessExtension {
    public static activate(context: vscode.ExtensionContext): void {
        try {
            context.subscriptions.push(
                vscode.commands.registerCommand(
                    "fluiggers-fluig-vscode-extension.importProcess",
                    ProcessService.import
                )
            );
            console.log("ProcessExtension: Comandos registrados com sucesso");
        } catch (error) {
            console.error(
                "ProcessExtension: Erro ao registrar comandos",
                error
            );
            vscode.window.showErrorMessage(
                `Erro ao ativar ProcessExtension: ${error}`
            );
        }
    }
}
