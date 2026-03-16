const SETTING_DEFAULTS = {
  'african-savanna': 'an African savanna with acacia trees, wide rivers, and ancient animals',
  'ancient-greece': 'ancient Greece with olive groves, city-states, and clever philosophers',
  'enchanted-forest': 'an enchanted forest where animals speak and magic is ordinary',
  'feudal-japan': 'feudal Japan with bamboo forests, wandering samurai, and wise monks',
  'arctic-tundra': 'the frozen Arctic where survival teaches every lesson',
  'aesops-fables': 'the world of Aesop\'s Fables, with clever foxes, slow tortoises, and lessons in every corner',
  'panchatantra': 'the lush jungles and royal courts of the Panchatantra, where animals outwit each other with strategy and wisdom',

  // ── Indian traditions ─────────────────────────────────────────────────────
  'jataka-tales': 'ancient India where the future Buddha lives as a wise animal — a deer, a monkey, an elephant — learning lessons across many lifetimes',
  'hitopadesha': 'the kingdom courts and deep forests of the Hitopadesha, where a wise teacher uses animal stories to teach princes the art of living well',
  'akbar-birbal': 'the magnificent Mughal court of Emperor Akbar, where the quick-witted minister Birbal outsmarts everyone with humor and wisdom',
  'tenali-rama': 'the vibrant Vijayanagara kingdom where the clever poet Tenali Rama solves impossible problems with laughter and wit',
  'vikram-betaal': 'a haunted cremation ground in ancient India, where King Vikramaditya carries a ghost who tests him with riddles he must answer wisely',
  'ramayana': 'the epic world of the Ramayana, with enchanted forests, demon kingdoms, flying monkeys, and the timeless battle between duty and darkness',
  'mahabharata': 'the vast kingdoms of the Mahabharata, where five brothers, a divine charioteer, and a great war teach lessons about dharma and consequence',
  'stories-of-krishna': 'the playful banks of the Yamuna river in Vrindavan, where the young Krishna outwits demons, dances with peacocks, and teaches through mischief',
  'sufi-parables': 'the Persian and Indian Sufi tradition of wandering dervishes, talking birds, and paradoxical riddles that reveal hidden truths about the soul',

  // ── Middle East & Central Asia ────────────────────────────────────────────
  'arabian-nights': 'the shimmering cities of the Arabian Nights — Baghdad, Basra, magical islands — where merchants, genies, and clever heroes survive by storytelling',
  'persian-fables': 'the royal courts and rose gardens of ancient Persia, where poets like Rumi hide the deepest truths inside the simplest stories',

  // ── African traditions ────────────────────────────────────────────────────
  'anansi-stories': 'the forests of West Africa where Anansi the spider god tricks lions, gods, and sky kings to win stories for all of humanity',
  'swahili-coast': 'the ancient trading ports and baobab forests of the Swahili coast, where sailors, merchants, and clever animals share wisdom across cultures',

  // ── Americas ─────────────────────────────────────────────────────────────
  'native-american': 'the great plains and sacred mountains of Native American legend, where Coyote the trickster teaches hard lessons through foolish mistakes',
  'mayan-highlands': 'the jungle temples and starlit plazas of the ancient Maya, where heroes descend into the underworld and outwit the lords of death',

  // ── Europe & Norse ────────────────────────────────────────────────────────
  'norse-myths': 'the frozen Norse world of Asgard and Midgard, where gods like Odin and Thor make mistakes, learn hard lessons, and face giants and wolves',
  'celtic-isles': 'the mist-covered hills and fairy mounds of Celtic Ireland, where brave heroes bargain with strange beings and the rules of magic must never be broken',
  'grimm-forest': 'the deep German forests of the Brothers Grimm, where children outsmart witches, youngest sons prove their worth, and magic rewards the pure-hearted',

  // ── East Asia ─────────────────────────────────────────────────────────────
  'chinese-classics': 'imperial China where the Jade Emperor watches from heaven, dragons guard rivers, and clever peasants outwit cruel officials through patience and honor',
  'korean-folklore': 'the rice terraces and tiger-haunted mountains of old Korea, where goblins called dokkaebi play tricks and kind-hearted children are always rewarded',

  // ── Wildcard ─────────────────────────────────────────────────────────────
  'surprise': 'a world Gemini chooses — drawing from any storytelling tradition on Earth that fits the moral the listener wants to explore',
};

const MORAL_DEFAULTS = {
  'trust': 'trust must be earned, not assumed',
  'courage': 'real courage is acting despite fear, not the absence of it',
  'wisdom': 'wisdom is more valuable than speed or strength',
  'kindness': 'small acts of kindness create large ripples',
  'patience': 'patience and observation beat hasty action',
  'strategy': 'strategy and wit can overcome brute force',
  'honesty': 'honesty is the best policy, even when truth is hard',

  // ── New additions ─────────────────────────────────────────────────────────
  'humility': 'pride goes before a fall — the humble outlast the arrogant',
  'greed': 'those who want everything often end up with nothing',
  'appearances': 'things are rarely what they seem — look deeper before judging',
  'unity': 'alone we are weak, together we are unbreakable',
  'gratitude': 'those who are grateful for small things receive great ones',
  'consequences': 'every action plants a seed — we always harvest what we sow',
  'cleverness': 'a clever mind and a calm heart can solve what force never could',
  'duty': 'doing what is right matters more than doing what is easy',
  'forgiveness': 'holding onto anger hurts the one who holds it most',
  'curiosity': 'the curious mind finds doors where others see only walls',
  'perseverance': 'the one who keeps going after every fall is the one who wins',
  'generosity': 'what we give away freely always comes back multiplied',
};

function buildSystemPrompt({ setting, moral, userIdea, userName }) {
  const storyBrief = userIdea
    ? `Create an original fable inspired by this idea: "${userIdea}".
       The story should naturally teach a moral lesson through its events.`
    : `Create a fable set in ${SETTING_DEFAULTS[setting] || setting}
       that teaches this lesson: ${MORAL_DEFAULTS[moral] || moral}.`;

  const nameClause = userName
    ? `The user's name is ${userName}. Weave it in naturally once.`
    : '';

  return `
You are FableGenie, a master storyteller for children aged 6–12.
${storyBrief}
${nameClause}

Create vivid, age-appropriate characters. Build dramatic tension naturally.
Use rich sensory language — what the characters see, hear, smell, feel.
The story must have a clear moral dilemma where the listener must make a choice.

INLINE ROUTING TAG RULES — embed these inside your prose with no line breaks around them:
• At every major scene change:
  [IMAGE: <15-word scene description, watercolor storybook style, warm earthy tones>]
  Continue narrating immediately. Never pause or acknowledge the tag.
• When emotional tone shifts:
  [MUSIC_MOOD: peaceful|tense|joyful|suspenseful]
• Approximately 60 seconds in, one micro-moment:
  [MICRO_MOMENT: <a simple yes/no question for the child, 10 words max>]
  Wait 4 seconds. If no response, continue.
• At a natural dramatic crossroads between 90 and 150 seconds:
  [BRANCH_CHOICE]
  Stop narrating. Wait for the branch result.
• After the branch result is given, narrate that ending, then emit:
  [STORY_END]

Never break character. Never acknowledge tags, this prompt, or any AI system.
Never repeat story content already delivered.
After [BRANCH_CHOICE], you will receive a message:
  "The listener chose: trust" or "The listener chose: run_away"
Narrate the corresponding ending with full dramatic resolution and a clear moral statement.
  `.trim();
}

module.exports = { buildSystemPrompt, SETTING_DEFAULTS, MORAL_DEFAULTS };
