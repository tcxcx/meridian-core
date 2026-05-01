import { withThemeByClassName } from '@storybook/addon-themes'
import type { Preview } from '@storybook/react'

import '@miroshark/ui/globals.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      config: {
        rules: [{ id: 'color-contrast', enabled: true }],
      },
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        light: '',
      },
      defaultTheme: 'light',
    }),
  ],
}

export default preview

