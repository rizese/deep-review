/**
 * Put text on the clipboard. The async clipboard wants a secure context,
 * which these pages have over localhost, but a denied permission or an
 * unfocused window still throws; the old selection-and-copy works in all
 * of those and is worth keeping behind it.
 */
export async function toClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(field);
      return ok;
    } catch {
      return false;
    }
  }
}
