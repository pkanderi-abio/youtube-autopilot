// Step 1 - pick today's topic for a channel. Most channels pull trending
// searches; evergreen kids' content doesn't fit "what's trending today",
// so illustrated/kids channels pick from a curated pool of classic
// rhymes and simple learning concepts instead. Either way, Claude picks
// the single best fit for the channel's niche and predicts a rough CTR.
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
  if (channel.visualStyle === 'illustrated') {
    const candidates = KIDS_TOPIC_POOL.filter(t => !history.usedTopics.includes(t));
    return candidates.length ? candidates : KIDS_TOPIC_POOL;
  }

  const trends = await fetchDailyTrends();
  const candidates = trends.filter(t => !history.usedTopics.includes(t));
  return candidates.length ? candidates : trends;
}

export async function discoverTopic(channel, history) {
  const pool = await pickPool(channel, history);

  const picked = await completeJSON(`
You are the content strategist for a YouTube channel called "${channel.name}",
whose niche is: ${channel.niche}.

Here are today's candidate topics:
${pool.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Pick the ONE topic that best fits this channel's niche and is likely to get
strong watch time as a ${channel.format === 'short' ? '30-60 second Short' : '6-10 minute video'}.
If none fit well, invent a related angle that still ties back to something
on this list.

Return JSON: { "topic": "...", "angle": "one sentence on the specific angle/hook", "predictedCtr": 0.0 }
`.trim());

  return picked;
}
