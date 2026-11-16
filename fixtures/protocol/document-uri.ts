/** URI policy of the generic host fixture; production hosts choose their own identities. */
export function fixtureDocumentUri(resourceId: string, documentId: string): string {
    return `host+fixture:workspace/${encodeURIComponent(resourceId)}/${encodeURIComponent(documentId)}`;
}
