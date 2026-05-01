'use client'

import dynamic from 'next/dynamic'

const UnicornScene = dynamic(() => import('unicornstudio-react'), {
  ssr: false,
  loading: () => null,
})

export function MirosharkUnicornScene({
  children,
  className = '',
  contentClassName = '',
  projectId = 'KfR1umh9DVubea96eoEI',
  variant = 'default',
  scale = 1,
  dpi = 1.5,
}) {
  const sceneClassName = ['ms-scene-shell', className].filter(Boolean).join(' ')
  const sceneContentClassName = ['ms-scene-content', contentClassName].filter(Boolean).join(' ')

  return (
    <div className={sceneClassName} data-variant={variant}>
      <div className="ms-scene-fixed" aria-hidden="true">
        <div className="ms-scene-canvas">
          <UnicornScene
            projectId={projectId}
            width="100%"
            height="100%"
            scale={scale}
            dpi={dpi}
            sdkUrl="https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@2.1.11/dist/unicornStudio.umd.js"
          />
        </div>
        <div className="ms-scene-mesh" />
        <div className="ms-scene-grid" />
      </div>
      <div className={sceneContentClassName}>{children}</div>
    </div>
  )
}
