// Triggers a browser file download of a JSON string via a transient object-URL
// anchor. Used by the store-admin Export action.

export function downloadJson(json: string, filename: string): void {
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}
