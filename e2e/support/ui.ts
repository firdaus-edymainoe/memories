import { expect, type Page } from "@playwright/test";

export function nav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

export function main(page: Page) {
  return page.locator("main");
}

export function details(page: Page) {
  return page.getByRole("complementary", { name: "Details" });
}

export function toast(page: Page, text: string | RegExp) {
  return page.getByText(text);
}

/** Add a place through the dialog. Uses the typed path because the native picker is not implemented. */
export async function addPlaceViaUi(page: Page, opts: { kind: RegExp; path: string; name: string }) {
  await nav(page).getByRole("button", { name: "Add a place" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: opts.kind }).click();
  await dialog.getByRole("button", { name: /Choose folder/ }).click();
  await dialog.getByLabel("Folder location").fill(opts.path);
  await dialog.getByLabel("Call it").fill(opts.name);
  await dialog.getByRole("button", { name: "Add place" }).click();
  await expect(dialog).toBeHidden();
}

export async function openFile(page: Page, name: string) {
  await main(page).getByRole("button", { name: new RegExp(escape(name)) }).first().click();
  await expect(details(page).getByRole("heading", { name })).toBeVisible();
}

export function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
