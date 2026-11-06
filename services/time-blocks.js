// Time blocks — fixed daily booking windows that limit where clients can start.
// Stored on artists.time_blocks as [{ start_min, end_min }] (minutes after midnight ET).

const MODES = ['off', 'default_on', 'optional'];
const MAX_BLOCKS = 12;

/**
 * Validate and normalize blocks from the settings form.
 * Returns { blocks } (sorted by start) or { error }.
 */
function validateTimeBlocks(raw, workStartHour, workEndHour) {
  if (!Array.isArray(raw)) return { error: 'time_blocks must be an array' };
  if (raw.length > MAX_BLOCKS) return { error: `You can have at most ${MAX_BLOCKS} time blocks` };

  const blocks = raw.map(b => ({ start_min: parseInt(b?.start_min), end_min: parseInt(b?.end_min) }));
  for (const b of blocks) {
    if (isNaN(b.start_min) || isNaN(b.end_min) || b.start_min % 30 || b.end_min % 30) {
      return { error: 'Time blocks must start and end on the hour or half hour' };
    }
    if (b.start_min >= b.end_min) return { error: 'Each time block must end after it starts' };
    if (b.start_min < workStartHour * 60 || b.end_min > workEndHour * 60) {
      return { error: 'Time blocks must fall within your working hours' };
    }
  }

  blocks.sort((a, b) => a.start_min - b.start_min);
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start_min < blocks[i - 1].end_min) return { error: 'Time blocks cannot overlap' };
  }
  return { blocks };
}

/**
 * The blocks that apply to a booking request, or null for normal slots.
 * Always uses the artist's CURRENT settings, so edits apply to links already sent.
 */
function resolveTimeBlocks(request, artist) {
  if (!request?.use_time_blocks) return null;
  if (!artist || (artist.time_blocks_mode || 'off') === 'off') return null;
  const blocks = Array.isArray(artist.time_blocks) ? artist.time_blocks : [];
  return blocks.length ? blocks : null;
}

module.exports = { MODES, validateTimeBlocks, resolveTimeBlocks };
