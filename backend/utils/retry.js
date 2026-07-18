/**
 * Retries a given function with exponential backoff.
 * 
 * @param {Function} fn - The function/promise to retry.
 * @param {number} maxRetries - The maximum number of attempts before throwing.
 * @param {number} initialDelay - Initial delay wait time in milliseconds.
 * @param {number} backoffFactor - Multiplier for each subsequent delay.
 * @returns {Promise<any>} Resolves with the result of the function call.
 */
export async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000, backoffFactor = 2) {
  let attempt = 1;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt > maxRetries) {
        console.error(`[Retry] Operation failed after ${maxRetries} attempts.`);
        throw error;
      }
      console.warn(`[Retry] Attempt ${attempt} of ${maxRetries} failed: "${error.message}". Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
      delay *= backoffFactor;
    }
  }
}
