import { expect, type Locator, type Page } from "@playwright/test";

export async function selectWorkspaceMenu(page: Page, label: string | RegExp, item: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

export async function expectInViewport(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

export async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth - innerWidth,
    height: document.documentElement.scrollHeight - innerHeight,
    bodyWidth: document.body.scrollWidth - innerWidth,
    bodyHeight: document.body.scrollHeight - innerHeight
  }));
  for (const difference of Object.values(overflow)) expect(difference).toBeLessThanOrEqual(0);
}
