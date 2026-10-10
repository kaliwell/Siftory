// ── Bilingual Query Lexicon (pure, electron-free) ──────────
// Chinese query words whose intent is narrower than the multilingual
// encoder's generic mapping (游戏 → cards/dice instead of video games,
// 色图 → game skins instead of lewd anime). When a CJK query exactly
// matches an entry, the English gloss is embedded with the English CLIP
// tower and fused with the multilingual embedding (same 512-d CLIP space).
// Users can override/extend entries via userData/query-lexicon.json.

export const BUILTIN_QUERY_LEXICON: Record<string, string> = {
  // 游戏
  游戏: 'video game',
  电子游戏: 'video game',
  游戏截图: 'video game screenshot',
  电竞: 'esports gaming',
  手游: 'mobile game',
  网游: 'online game',
  桌游: 'board game',
  卡牌: 'playing cards',
  扑克: 'poker cards',
  麻将: 'mahjong',
  // 动漫
  动漫: 'anime',
  动画: 'anime',
  卡通: 'cartoon',
  漫画: 'manga',
  二次元: 'anime',
  番剧: 'anime series',
  立绘: 'anime character illustration',
  同人: 'anime fan art',
  表情包: 'meme sticker',
  头像: 'avatar portrait',
  // 人物 / 敏感词
  色图: 'lewd anime',
  涩图: 'lewd anime',
  性感: 'sexy',
  美女: 'beautiful woman',
  美少女: 'beautiful anime girl',
  帅哥: 'handsome man',
  少女: 'young girl',
  萝莉: 'anime girl',
  御姐: 'elegant mature woman',
  女仆: 'maid costume',
  猫耳: 'cat ears',
  兔女郎: 'bunny girl',
  泳装: 'swimsuit',
  比基尼: 'bikini',
  内衣: 'lingerie',
  裸体: 'nude',
  胸: 'breasts',
  臀: 'buttocks',
  腿: 'legs',
  美腿: 'slender legs',
  足: 'bare feet',
  脚: 'bare feet',
  丝袜: 'stockings',
  黑丝: 'black stockings',
  白丝: 'white stockings',
  网袜: 'fishnet stockings',
  长筒袜: 'knee high socks',
  高跟鞋: 'high heels',
  短裙: 'short skirt',
  紧身衣: 'tight bodysuit',
  职业装: 'office lady outfit',
  校服: 'school uniform',
  旗袍: 'cheongsam',
  // 日常 / 场景
  猫: 'cat',
  狗: 'dog',
  宠物: 'pet',
  美食: 'delicious food',
  食物: 'food',
  夜景: 'city night scene',
  海滩: 'beach',
  海边: 'seaside',
  汽车: 'car',
  跑车: 'sports car',
  花: 'flowers',
  天空: 'sky',
  日落: 'sunset',
  日出: 'sunrise',
  雪: 'snow',
  雨: 'rain',
  街景: 'street view',
  建筑: 'architecture',
  城市: 'city',
  森林: 'forest',
  湖: 'lake',
  自拍: 'selfie',
  截图: 'screenshot',
  壁纸: 'wallpaper',
  风景: 'landscape scenery',
  演唱会: 'concert',
  电影: 'movie',
  明星: 'celebrity',
  孩子: 'child',
  婴儿: 'baby',
  婚礼: 'wedding',
  电脑: 'computer',
  手机: 'smartphone',
  键盘: 'keyboard',
  耳机: 'headphones',
}

const MAX_KEY_LENGTH = 32
const MAX_GLOSS_LENGTH = 128

// User file shape: { "游戏": "video game", ... }. Invalid entries are dropped;
// a malformed file falls back to the builtin lexicon alone.
export function mergeQueryLexicon(
  userJson: unknown,
  builtin: Record<string, string> = BUILTIN_QUERY_LEXICON,
): Record<string, string> {
  const merged: Record<string, string> = { ...builtin }
  if (!userJson || typeof userJson !== 'object' || Array.isArray(userJson)) return merged
  for (const [key, value] of Object.entries(userJson as Record<string, unknown>)) {
    const trimmedKey = key.trim()
    if (!trimmedKey || trimmedKey.length > MAX_KEY_LENGTH) continue
    if (typeof value !== 'string') continue
    const gloss = value.trim()
    if (!gloss || gloss.length > MAX_GLOSS_LENGTH) continue
    merged[trimmedKey] = gloss
  }
  return merged
}

export function lookupQueryGloss(lexicon: Record<string, string>, text: string): string | null {
  const gloss = lexicon[text.trim()]
  return typeof gloss === 'string' && gloss ? gloss : null
}
