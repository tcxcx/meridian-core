import { MirosharkMarketingHome } from '@miroshark/ui/marketing-home'

export default function WebHome() {
  const appOrigin = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3301').replace(/\/$/, '')

  return <MirosharkMarketingHome appOrigin={appOrigin} />
}
