import { SiBytedance, SiDeepseek, SiKuaishou } from 'react-icons/si';
import { TbBrandOpenai } from 'react-icons/tb';
import unicompApiLogo from '../../assets/provider-logos/unicompapi.png';
import viduLogo from '../../assets/provider-logos/vidu.svg';

const providerBrands = {
  'provider-package-deepseek': { name: 'deepseek', icon: SiDeepseek },
  'provider-package-volcengine': { name: 'volcengine', icon: SiBytedance },
  'provider-package-kling': { name: 'kling', icon: SiKuaishou },
  'provider-package-newapi': { name: 'openai', icon: TbBrandOpenai },
  'provider-package-unicompapi': { name: 'unicomp', image: unicompApiLogo },
  'provider-package-vidu-v1': { name: 'vidu', image: viduLogo }
} as const;

export function ProviderBrandIcon({
  className,
  label,
  packageId
}: {
  readonly className: string;
  readonly label: string;
  readonly packageId: string;
}) {
  const brand = providerBrands[packageId as keyof typeof providerBrands];
  const Icon = brand && 'icon' in brand ? brand.icon : undefined;
  const image = brand && 'image' in brand ? brand.image : undefined;

  return (
    <span
      aria-hidden="true"
      className={className}
      data-provider-brand={brand?.name ?? 'fallback'}
    >
      {image ? <img alt="" src={image} /> : Icon ? <Icon /> : label.slice(0, 1)}
    </span>
  );
}
