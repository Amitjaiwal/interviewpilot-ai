import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_FOLDER_NAME, resolveUserDataPath } from '../../electron/user-data';

describe('resolveUserDataPath', () => {
  const appData = path.join('C:', 'Users', 'Someone', 'AppData', 'Roaming');

  it('keeps using the folder every earlier version used, whatever the app is called now', () => {
    expect(DATA_FOLDER_NAME).toBe('InterviewPilot AI');
    expect(resolveUserDataPath(appData)).toBe(path.join(appData, 'InterviewPilot AI'));
  });

  it('uses the override folder when one is given, as an absolute path', () => {
    const override = path.join('D:', 'portable', 'data');
    expect(resolveUserDataPath(appData, override)).toBe(path.resolve(override));
  });

  it('ignores an empty override', () => {
    expect(resolveUserDataPath(appData, '')).toBe(path.join(appData, 'InterviewPilot AI'));
    expect(resolveUserDataPath(appData, undefined)).toBe(path.join(appData, 'InterviewPilot AI'));
  });
});
