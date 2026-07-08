// Step 1 - pick today's topic for a channel. Most channels pull trending
// searches; evergreen kids' content doesn't fit "what's trending today",
// so kids channels pick from a curated pool of classic rhymes and simple
// learning concepts instead. Either way, the model picks the single best
// fit for the channel's niche and predicts a rough CTR.
import { fetchDailyTrends } from '../lib/trends.js';
import { completeJSON } from '../lib/llm.js';

const KIDS_TOPIC_POOL = [
  'Twinkle Twinkle Little Star',
  'Baa Baa Black Sheep',
  'Row Row Row Your Boat',
  'The Itsy Bitsy Spider',
  'Old MacDonald Had a Farm',
  'The Wheels on the Bus',
  'Head Shoulders Knees and Toes',
  'The ABC Song',
  'If You\'re Happy and You Know It',
  'Hickory Dickory Dock',
  'Jack and Jill',
  'Humpty Dumpty',
  'This Little Piggy',
  'Five Little Ducks',
  'Mary Had a Little Lamb',
  'Learning to count from 1 to 10',
  'Learning the colors of the rainbow',
  'Learning basic shapes',
  'Animal sounds for toddlers',
  'Days of the week song'
];

async function pickPool(channel, history) {
  if (channel.madeForKids) {
    const candidates = KIDS_TOPIC_POOL.filter(t => !history.usedTopics.includes(t));
    return candidates.length ? candidates : KIDS_TOPIC_POOL;
  }

  const trends = await fetchDailyTrends();
  const candidates = trends.filter(t => !history.usedTopics.includes(t));
  return candidates.length ? candidates : trends;
}

export async function discoverTopic(channel, history) {
  const pool = await pickPool(channel, history);

  // Observed failure mode with a small local model: it picks a raw
  // trending term (a sports score, a news anchor's name) and writes a
  // generic recap with no real connection to the channel's niche - e.g.
  // a travel/lifestyle channel publishing sports-highlight-reel videos.
  // The fix is a much more directive, example-driven prompt: the
  // returned "topic" must already read as a niche topic, not a bare
  // trending term, and a term with no plausible tie-in should be
  // reframed or replaced rather than used as-is.
  const picked = await completeJSON(`
You are the content strategist for a YouTube channel called "${channel.name}",
whose niche is: ${channel.niche}.

Here are today's trending searches:
${pool.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Your job is to turn ONE of these into a video topic that is EXPLICITLY
about ${channel.niche} - not a recap of the trending term in isolation.
If a trending term has no real connection to this niche (e.g. a raw
sports score, a news anchor's name, an unrelated event), do not just
write a generic video about that term - either find a genuine angle
that ties it to the niche, or discard it and invent a different topic
that clearly fits the niche instead.

Example (niche: travel & lifestyle):
- Trending: "Super Bowl" -> good topic: "The most underrated cities to
  visit for next year's Super Bowl" (ties the trend to travel).
- Trending: "Local team wins championship game" -> BAD: a sports recap
  video has no travel/lifestyle angle. Either skip it or invent an
  unrelated but niche-fitting topic instead.

The "topic" field you return must already read as a ${channel.niche}
topic, not a bare copy of a trending term. The "angle" field must state
specifically why/how it connects to the niche.

Return JSON: { "topic": "...", "angle": "one sentence on the specific angle/hook", "predictedCtr": 0.0 }
`.trim());

  return picked;
}
