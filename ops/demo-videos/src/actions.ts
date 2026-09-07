/** Small, defensive page-action helpers shared by scenes. */
import type { Page } from 'playwright';

/** Navigate without letting a slow third-party asset stall the take. */
export async function visit(page: Page, url: string, settleMs = 1200): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

/** Ease down the page in wheel ticks so the recording pans instead of jumping. */
export async function glideDown(page: Page, totalPx: number, tickPx = 220, tickMs = 140): Promise<void> {
  let remaining = totalPx;
  while (remaining > 0) {
    const px = Math.min(tickPx, remaining);
    await page.mouse.wheel(0, px);
    remaining -= px;
    await page.waitForTimeout(tickMs);
  }
}

/** Click the first visible match if it appears quickly; never fails the step. */
export async function tryClick(page: Page, text: RegExp, timeoutMs = 2_500): Promise<boolean> {
  try {
    const link = page.getByRole('link', { name: text }).first();
    await link.waitFor({ state: 'visible', timeout: timeoutMs });
    await link.click({ timeout: timeoutMs });
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  } catch {
    return false;
  }
}
