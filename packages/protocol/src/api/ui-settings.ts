import { z } from 'zod';

/** `GET /api/ui-settings`: the settings the screens need (04, section 8). */
export const UiSettingsResponse = z.object({
  /** How often the project page refreshes while its repository setup runs (02, section 6.2). */
  projectSetupPollSeconds: z.number().positive(),
});
export type UiSettingsResponse = z.infer<typeof UiSettingsResponse>;
