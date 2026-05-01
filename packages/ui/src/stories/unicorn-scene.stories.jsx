import { MirosharkUnicornScene } from '../components/unicorn-scene'

export default {
  title: 'MiroShark/Unicorn Scene',
  component: MirosharkUnicornScene,
}

export const MarketingBackdrop = {
  render: () => (
    <MirosharkUnicornScene variant="marketing">
      <div style={{ minHeight: '100vh', padding: 32, display: 'grid', placeItems: 'center' }}>
        <section className="ms-card" style={{ width: 'min(720px, 100%)' }}>
          <div className="ms-card-head">
            <div className="ms-card-head-l">
              <span className="ms-chip">WEB</span>
              <span className="ms-card-eyebrow">Backdrop Specimen</span>
            </div>
            <span className="ms-card-head-r">marketing</span>
          </div>
          <div className="ms-card-title">Public landing and setup should share the same scene.</div>
          <p className="ms-card-copy">
            The backdrop is not decorative wallpaper. It is the atmospheric bridge between the public user story and the private operator setup routes.
          </p>
        </section>
      </div>
    </MirosharkUnicornScene>
  ),
}
