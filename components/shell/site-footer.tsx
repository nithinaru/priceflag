type SiteFooterProps = {
  shopDomain?: string;
};

export function SiteFooter({ shopDomain }: SiteFooterProps) {
  return (
    <footer role="contentinfo" className="pf-app-foot">
      <div className="pf-app-foot-inner">
        {shopDomain ? <p className="pf-app-foot-shop">{shopDomain}</p> : null}
        <div className="pf-app-foot-bar">
          <span>Built by Humans in San Francisco, CA</span>
          <div className="pf-app-foot-legal">
            <a href="https://www.streamlinehq.com">Icons by Streamline, CC BY 4.0</a>
            <a href="https://priceflag.org/contact">Contact</a>
            <a href="https://priceflag.org/legal">Legal</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
