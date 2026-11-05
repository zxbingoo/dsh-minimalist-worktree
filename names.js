import { randomInt } from 'node:crypto';

// Original, local word lists: readable names without dependencies or network requests.
export const ADJECTIVES = Object.freeze(`
  ripe calm brave brisk bright clear clever cool cozy crisp curious daring
  deep eager early fair fancy fast fine firm fresh friendly frosty gentle
  glad golden graceful grand green happy hazy hidden humble icy jolly keen
  kind lively lucky mellow merry mild misty modern neat nimble noble odd
  pale patient peaceful playful polite proud quick quiet rapid ready red rich
  rosy round royal sandy sharp shiny silent silver simple sleek sleepy slim
  small smart smooth snowy soft solid spare spicy spring steady still sunny
  sweet swift tall tender tidy tiny vivid warm wild wise witty young
`.trim().split(/\s+/));

export const NOUNS = Object.freeze(`
  bird badger bear beaver bison bloom brook breeze cedar cherry cloud coral
  crane creek crow deer delta dove duck dune eagle elm falcon fern finch
  flame flower forest fox frog garden gecko grove gull hare hawk hazel
  heron hill island ivy jade jay kiwi koala lake lark leaf lemon
  lily lion lotus lynx maple meadow moon moss moth oak ocean olive
  otter owl panda peach pearl pine pond poppy quail raven reef river
  robin rock rose sage seal shore sky snow sparrow spring star stone
  storm stream sun swan swift tiger trail tree tulip turtle valley willow
`.trim().split(/\s+/));

export const NAME_ATTEMPTS = 64;

export function generateWorktreeName(random = randomInt) {
  return `dsh/${ADJECTIVES[random(ADJECTIVES.length)]}-${NOUNS[random(NOUNS.length)]}`;
}

/** Reserve before awaiting Git so concurrent blank Sessions cannot choose the same name. */
export function createWorktreeNamer({ isAvailable, random = randomInt }) {
  const reserved = new Set();
  return async (agent, cwd, signal) => {
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const name = generateWorktreeName(random);
      if (reserved.has(name)) continue;
      reserved.add(name);
      let keep = false;
      try {
        if (await isAvailable(agent, cwd, name, signal)) {
          signal?.throwIfAborted();
          keep = true;
          return name;
        }
      } finally {
        if (!keep) reserved.delete(name);
      }
    }
    throw new Error('Could not choose an unused dsh/<adjective>-<noun> name. Select Local, then New worktree to choose again.');
  };
}
