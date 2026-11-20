import * as path from 'node:path';

/**
 * Settings, history, logs, the encrypted Groq key and downloaded speech files live in this
 * folder under %APPDATA%. It keeps the app's first name on purpose: Electron names the data
 * folder after the product, so following a rename would leave every existing user's data
 * behind and make the app start as if it were new. Do not change this when the app is renamed.
 */
export const DATA_FOLDER_NAME = 'InterviewPilot AI';

/**
 * Where the app keeps its data: the folder in INTERVIEWPILOT_USER_DATA when it is set (tests,
 * portable use), otherwise DATA_FOLDER_NAME inside the Windows app-data folder.
 */
export function resolveUserDataPath(appData: string, override?: string): string {
  return override ? path.resolve(override) : path.join(appData, DATA_FOLDER_NAME);
}
