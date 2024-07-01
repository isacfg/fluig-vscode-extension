$(function () {
    $("#formConfig").on("submit", function (event) {
        event.preventDefault();

        const vscode = acquireVsCodeApi();

        vscode.postMessage({
            command: 'save',
            serverId: document.getElementById("server").value,
            parentId: document.getElementById("parentId").value,
            datasetName: document.getElementById("datasetName").value,
            persistenceType: document.getElementById("persistenceType").value,
            descriptionField: document.getElementById("descriptionField").value,
        });
    });
});