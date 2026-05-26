// Shared keyboard builders so every handler sends a consistent UI.
//
// Why InlineKeyboard (not Keyboard.webApp + .persistent)?
// Reply-keyboard web_app buttons don't reliably pass initData across Telegram
// client versions — many users see "missing_init_data" 401s. Inline keyboard
// web_app buttons always pass initData. For persistent visibility, rely on
// BotFather `/setmenubutton` — that icon at the bottom-left of the chat input
// is the canonical Telegram "always-on" WebApp launcher and is far less buggy.

import { InlineKeyboard } from 'grammy';

export function webAppKeyboard(webAppUrl: string) {
	return new InlineKeyboard().webApp('🚀 Open Depot App', webAppUrl);
}
