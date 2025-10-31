//tdn.totvs.com/display/public/fluig/Guia+de+Propriedades+dos+Objetos#GuiadePropriedadesdosObjetos-ProcessDefinitionDto
export interface ProcessDefinitionDto {
    companyId: number;
    processId: string;
    processDescription: string;
    active: boolean;
}

export interface ProcessDTO {
    processId: string;
    processName?: string;
    processDescription?: string;
    processVersion?: number | string;
    [key: string]: unknown;
}
