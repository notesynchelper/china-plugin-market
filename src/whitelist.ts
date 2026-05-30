/**
 * 产品自有域白名单。
 *
 * 调起链接（obsidian:// 协议）与特殊导入的 manifest/assetBase 来源 URL，
 * 其 host 必须落在白名单内（精确域或其子域），且必须 https。
 * 调起安装源**不限于产品主站**——白名单数组里任一产品自有域托管的链接都放行。
 *
 * 域名来源：chinahomepage/CLAUDE.md 合规 §2「产品自有域」。
 */
export const PRODUCT_DOMAINS: readonly string[] = [
	"notebooksyncer.com", // obsidian.notebooksyncer.com 等
	"bijitongbu.site", // relay-1/2、shoujidiannao、graph、www 等子域
	"notehelper.app",
	"clipfx.app", // getcontent / pic 等
	"onenotes.app",
] as const;

/**
 * host 是否属于某个产品自有域（精确或子域）。
 *
 * 防钓鱼：
 *  - "bijitongbu.site.evil.com"  → 拒绝（不以 ".bijitongbu.site" 结尾）
 *  - "evilbijitongbu.site"       → 拒绝（无分隔点）
 *  - "relay-1.bijitongbu.site"   → 放行（子域）
 *  - "bijitongbu.site"           → 放行（精确）
 */
export function isAllowedHost(host: string): boolean {
	if (!host) return false;
	const h = host.trim().toLowerCase();
	// 去掉可能的端口
	const bare = h.split(":")[0];
	if (!bare) return false;
	return PRODUCT_DOMAINS.some(
		(d) => bare === d || bare.endsWith("." + d)
	);
}

/**
 * URL 是否可信：必须 https 且 host 命中白名单。
 * 解析失败一律 false。
 */
export function isAllowedUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "https:") return false;
	return isAllowedHost(u.hostname);
}
