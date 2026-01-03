// In-memory conversation store for stateful chat sessions
// Map<sessionId, Array<{ role: 'user' | 'assistant', content: string }>>
const conversations = new Map();

/**
 * Get conversation history for a session (without the system prompt).
 * @param {string|null} sessionId - Session identifier
 * @returns {Array<{role: string, content: string}>} Conversation history
 */
export function getHistory(sessionId) {
  if (!sessionId) return [];
  return conversations.get(sessionId) || [];
}

/**
 * Append a message to the history for a session.
 * @param {string|null} sessionId - Session identifier
 * @param {Object} message - Message object with role and content
 * @param {string} message.role - 'user' or 'assistant'
 * @param {string} message.content - Message content
 */
export function appendMessage(sessionId, message) {
  if (!sessionId) return;
  const history = conversations.get(sessionId) || [];
  history.push({ role: message.role, content: message.content });
  conversations.set(sessionId, history);
}

/**
 * Optionally clear a session (not strictly needed now).
 * @param {string|null} sessionId - Session identifier
 */
export function clearHistory(sessionId) {
  if (!sessionId) return;
  conversations.delete(sessionId);
}














